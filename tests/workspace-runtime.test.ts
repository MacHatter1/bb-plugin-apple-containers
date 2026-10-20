import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  workspaceKey,
  readWorkspaceTarget,
  workspaceRuntime,
  workspaceTeardown,
} from "../lib/workspace-runtime";
import {
  workspaceSetupProfileSchema,
  workspaceTargetSchema,
} from "../lib/workspace-schema";
import type { Runner } from "../lib/process";
import { success } from "./fixtures";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "bb-workspace-test-")),
  );
  directories.push(directory);
  const target = workspaceTargetSchema.parse({
    projectId: "project-a",
    environmentId: "environment-a",
    path: directory,
    profile: {
      enabled: true,
      app: {
        name: "app",
        image: "alpine:3.23",
        command: ["sleep", "infinity"],
        ports: [3000],
      },
      services: [
        {
          name: "database",
          image: "alpine:3.23",
          command: ["sleep", "infinity"],
          ports: [5432],
          volumes: [{ name: "data", target: "/data" }],
        },
      ],
    },
  });
  const containers = new Map<
    string,
    {
      id: string;
      configuration: {
        labels: Record<string, string>;
        image: { reference: string };
        resources: object;
      };
      status: { state: string; networks: { ipv4Address: string }[] };
    }
  >();
  const volumes = new Map<string, object>(),
    networks = new Map<string, object>();
  const calls: string[][] = [];
  let unknownRun = false,
    failInventory = false;
  const runner: Runner = async (args) => {
    calls.push(args);
    if (args[0] === "system") return success("status running");
    if (args[0] === "list")
      return failInventory
        ? { ...success(), ok: false, exitCode: 1, stderr: "offline" }
        : success(JSON.stringify([...containers.values()]));
    if (args[0] === "inspect")
      return success(
        JSON.stringify(
          containers.has(args[1]!) ? [containers.get(args[1]!)] : [],
        ),
      );
    if (args[0] === "network" || args[0] === "volume") {
      const resources = args[0] === "network" ? networks : volumes;
      if (args[1] === "list")
        return success(JSON.stringify([...resources.values()]));
      if (args[1] === "create") {
        const name = args.at(-1)!;
        resources.set(name, { name, labels: labels(args) });
        return success(name);
      }
      if (args[1] === "delete") {
        resources.delete(args[2]!);
        return success();
      }
    }
    if (args[0] === "run") {
      const id = args[args.indexOf("--name") + 1]!;
      if (containers.has(id)) throw new Error("duplicate container");
      containers.set(id, {
        id,
        configuration: {
          labels: labels(args),
          image: { reference: "alpine:3.23" },
          resources: {},
        },
        status: {
          state: "running",
          networks: [{ ipv4Address: `192.168.64.${containers.size + 2}/24` }],
        },
      });
      if (unknownRun) {
        unknownRun = false;
        return {
          ...success(),
          ok: false,
          exitCode: 124,
          stderr: "CLI timeout; operation outcome unknown",
        };
      }
      return success(id);
    }
    if (args[0] === "delete") {
      containers.delete(args[1]!);
      return success();
    }
    const item = containers.get(args[1]!);
    if (item && (args[0] === "stop" || args[0] === "start"))
      item.status.state = args[0] === "stop" ? "stopped" : "running";
    return success();
  };
  return {
    directory,
    target,
    runner,
    calls,
    containers,
    volumes,
    networks,
    setUnknownRun() {
      unknownRun = true;
    },
    setFailInventory() {
      failInventory = true;
    },
  };
}
function labels(args: string[]) {
  return Object.fromEntries(
    args.flatMap((v, i) => (v === "--label" ? [args[i + 1]!.split("=")] : [])),
  );
}

it.each([
  ["db", "backup-data", "db-backup", "data"],
  ["app", "cache-data", "app-cache", "data"],
])(
  "rejects colliding volume identities for %s/%s and %s/%s",
  (firstService, firstVolume, secondService, secondVolume) => {
    const service = (name: string, volume: string) => ({
      name,
      image: "alpine:3.23",
      volumes: [{ name: volume, target: "/data" }],
    });
    expect(() =>
      workspaceSetupProfileSchema.parse({
        app:
          firstService === "app"
            ? service(firstService, firstVolume)
            : { name: "app", image: "alpine:3.23" },
        services: [
          ...(firstService === "app"
            ? []
            : [service(firstService, firstVolume)]),
          service(secondService, secondVolume),
        ],
      }),
    ).toThrow(/volume resource/i);
  },
);

it("keeps legacy colliding profiles inspectable and cleanable while refusing startup", async () => {
  const s = await setup();
  const target = workspaceTargetSchema.parse({
    ...s.target,
    profile: {
      ...s.target.profile,
      services: [
        {
          name: "db",
          image: "alpine:3.23",
          volumes: [{ name: "backup-data", target: "/data" }],
        },
        {
          name: "db-backup",
          image: "alpine:3.23",
          volumes: [{ name: "data", target: "/data" }],
        },
      ],
    },
  });
  await mkdir(join(s.directory, "workspaces"));
  await writeFile(
    join(s.directory, "workspaces", `${workspaceKey(target)}.json`),
    JSON.stringify({ target, services: [], appEnvironment: [] }),
  );
  expect(await readWorkspaceTarget(target, s.directory)).toEqual(target);
  await expect(
    workspaceRuntime(target, "ensure", s.directory, s.runner),
  ).rejects.toThrow(/volume resource/i);
  expect(s.calls).toHaveLength(0);
  expect(
    await workspaceRuntime(target, "status", s.directory, s.runner),
  ).toMatchObject({ configured: true });
  expect(
    await workspaceTeardown(
      target,
      { dryRun: false, removeVolumes: false },
      s.directory,
      s.runner,
    ),
  ).toMatchObject({ kind: "removed" });
  expect(await readWorkspaceTarget(target, s.directory)).toBeNull();
});

it("previews teardown without changes, preserves data by default, then purges retained volumes on request", async () => {
  const s = await setup();
  const first = await workspaceRuntime(
    s.target,
    "ensure",
    s.directory,
    s.runner,
  );
  const other = { ...s.target, environmentId: "another-worktree" };
  const second = await workspaceRuntime(other, "ensure", s.directory, s.runner);
  const file = join(
    s.directory,
    "workspaces",
    `${workspaceKey(s.target)}.json`,
  );
  const saved = await readFile(file, "utf8");
  const options = { removeVolumes: false, dryRun: true };
  const before = s.calls.length;
  const preview = await workspaceTeardown(
    s.target,
    options,
    s.directory,
    s.runner,
  );
  expect(preview).toMatchObject({
    kind: "preview",
    containers: expect.arrayContaining(first.services.map((s) => s.id)),
    volumes: [],
    retainedVolumes: first.services.flatMap((s) => s.volumes),
  });
  expect(s.calls.slice(before).every((c) => c.includes("list"))).toBe(true);
  expect(await readFile(file, "utf8")).toBe(saved);
  const removed = await workspaceTeardown(
    s.target,
    { ...options, dryRun: false },
    s.directory,
    s.runner,
  );
  expect(removed).toMatchObject({ kind: "removed", volumes: [] });
  expect([...s.containers.keys()]).toEqual(second.services.map((s) => s.id));
  expect(s.volumes.size).toBe(2);
  expect(s.networks.size).toBe(1);
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  // Volume labels allow later cleanup even after the host manifest was removed.
  const purged = await workspaceTeardown(
    s.target,
    { removeVolumes: true, dryRun: false },
    s.directory,
    s.runner,
  );
  expect(purged).toMatchObject({
    kind: "removed",
    containers: [],
    retainedVolumes: [],
    volumes: first.services.flatMap((s) => s.volumes),
  });
  expect(s.volumes.size).toBe(1);
  expect(
    await workspaceTeardown(
      s.target,
      { removeVolumes: true, dryRun: false },
      s.directory,
      s.runner,
    ),
  ).toMatchObject({ kind: "absent" });
  expect(s.calls.some((c) => c[0] === "image" || c.includes("prune"))).toBe(
    false,
  );
});

it("reuses retained volume names after teardown and catches orphaned resources from an earlier recipe", async () => {
  const s = await setup();
  const state = await workspaceRuntime(
    s.target,
    "ensure",
    s.directory,
    s.runner,
  );
  const database = s.containers.get(state.services[0]!.id)!;
  const orphan = `${state.services[0]!.id}-old`;
  s.containers.set(orphan, { ...database, id: orphan });
  const result = await workspaceTeardown(
    s.target,
    { removeVolumes: false, dryRun: false },
    s.directory,
    s.runner,
  );
  expect(result).toMatchObject({
    containers: expect.arrayContaining([orphan]),
  });
  expect(s.containers.size).toBe(0);
  const recreated = await workspaceRuntime(
    s.target,
    "ensure",
    s.directory,
    s.runner,
  );
  expect(recreated.services.flatMap((s) => s.volumes)).toEqual(
    state.services.flatMap((s) => s.volumes),
  );
  expect(s.volumes.size).toBe(1);
});

it("preflights ownership and complete inventory before deleting anything", async () => {
  const s = await setup();
  await workspaceRuntime(s.target, "ensure", s.directory, s.runner);
  const prefix = `bb-ws-${workspaceKey(s.target)}`;
  const network = s.networks.get(prefix)!;
  s.networks.set(prefix, { name: prefix, labels: {} });
  const before = s.calls.length;
  await expect(
    workspaceTeardown(
      s.target,
      { removeVolumes: true, dryRun: false },
      s.directory,
      s.runner,
    ),
  ).rejects.toThrow("another workspace");
  expect(s.calls.slice(before).every((c) => c.includes("list"))).toBe(true);
  expect(s.containers.size).toBe(2);
  s.networks.set(prefix, network);
  const failing: Runner = async (args, ...rest) =>
    args[0] === "volume" && args[1] === "list"
      ? {
          ...success(),
          ok: false,
          exitCode: 1,
          stderr: "volume inventory unavailable",
        }
      : s.runner(args, ...rest);
  await expect(
    workspaceTeardown(
      s.target,
      { removeVolumes: true, dryRun: false },
      s.directory,
      failing,
    ),
  ).rejects.toThrow("volume inventory unavailable");
  expect(s.containers.size).toBe(2);
});

it("retains the manifest on a partial failure and safely resumes cleanup", async () => {
  const s = await setup();
  await workspaceRuntime(s.target, "ensure", s.directory, s.runner);
  const failing: Runner = async (args, ...rest) =>
    args[0] === "network" && args[1] === "delete"
      ? { ...success(), ok: false, exitCode: 124, stderr: "outcome unknown" }
      : s.runner(args, ...rest);
  await expect(
    workspaceTeardown(
      s.target,
      { removeVolumes: true, dryRun: false },
      s.directory,
      failing,
    ),
  ).rejects.toThrow("outcome unknown");
  expect(s.containers.size).toBe(0);
  expect(s.networks.size).toBe(1);
  const file = join(
    s.directory,
    "workspaces",
    `${workspaceKey(s.target)}.json`,
  );
  expect(await readFile(file, "utf8")).toContain("environment-a");
  expect(
    await workspaceTeardown(
      s.target,
      { removeVolumes: true, dryRun: false },
      s.directory,
      s.runner,
    ),
  ).toMatchObject({
    kind: "removed",
    containers: [],
    volumes: [],
    networks: [expect.any(String)],
  });
});
describe("project workspace lifecycle", () => {
  it("mounts an API workspace after its dependencies and refreshes discovery on restart", async () => {
    const s = await setup();
    const target = workspaceTargetSchema.parse({
      ...s.target,
      profile: {
        ...s.target.profile,
        app: { ...s.target.profile.app, mountWorkspace: true },
        services: [
          ...s.target.profile.services,
          {
            name: "api",
            image: "alpine:3.23",
            mountWorkspace: true,
            command: ["sleep", "infinity"],
            ports: [8081],
          },
        ],
      },
    });
    const first = await workspaceRuntime(
      target,
      "ensure",
      s.directory,
      s.runner,
    );
    const database = first.services[0]!;
    const api = first.services[1]!;
    const app = first.services[2]!;
    const runs = s.calls.filter((v) => v[0] === "run");
    expect(runs.map((v) => v[v.indexOf("--name") + 1])).toEqual([
      database.id,
      api.id,
      app.id,
    ]);
    expect(runs[0]!.some((v) => v.includes("target=/workspace"))).toBe(false);
    expect(runs[1]).toContain(
      `type=bind,source=${s.directory},target=/workspace`,
    );
    expect(runs[1]).toContain("DATABASE_HOST=192.168.64.2");
    expect(runs[1]).toContain(
      "BB_WORKSPACE_SERVICES_FILE=/run/bb-workspace/services.json",
    );
    expect(runs[1]!.some((v) => v.startsWith("API_HOST="))).toBe(false);
    expect(runs[2]).toContain(`API_PUBLISHED_PORT=${api.ports[0]!.host}`);
    const file = join(
      s.directory,
      "workspaces",
      `${workspaceKey(target)}-connections`,
      "services.json",
    );
    expect(JSON.parse(await readFile(file, "utf8")).services).toEqual(
      first.services,
    );
    const record = s.containers.get(api.id)!;
    record.status.state = "stopped";
    record.status.networks[0]!.ipv4Address = "192.168.64.99/24";
    await workspaceRuntime(target, "ensure", s.directory, s.runner);
    expect(s.calls.filter((v) => v[0] === "run")).toHaveLength(3);
    const state = JSON.parse(await readFile(file, "utf8"));
    expect(
      state.services.find((v: { name: string }) => v.name === "api").address,
    ).toBe("192.168.64.99");
  });

  it("repairs a persisted request action without changing containers, ports or volumes", async () => {
    const s = await setup();
    const first = await workspaceRuntime(
      s.target,
      "ensure",
      s.directory,
      s.runner,
    );
    const file = join(
      s.directory,
      "workspaces",
      `${workspaceKey(s.target)}.json`,
    );
    const original = await readFile(file, "utf8");
    const legacy = original.replace(
      '"target":{',
      '"target":{"action":"ensure",',
    );
    expect(legacy).not.toBe(original);
    await writeFile(file, legacy);
    expect(await readWorkspaceTarget(s.target, s.directory)).toEqual(s.target);
    expect(await readFile(file, "utf8")).toBe(legacy);
    const before = s.calls.length;
    const status = await workspaceRuntime(
      s.target,
      "status",
      s.directory,
      s.runner,
    );
    expect(status).toEqual(first);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(s.calls.slice(before).every((args) => args[0] === "list")).toBe(
      true,
    );
    expect(
      await workspaceRuntime(s.target, "ensure", s.directory, s.runner),
    ).toEqual(first);
    expect(s.calls.filter((args) => args[0] === "run")).toHaveLength(
      first.services.length,
    );
  });
  it.each([{ action: "prune" }, { unexpected: true }])(
    "rejects other malformed saved target fields: %j",
    async (extra) => {
      const s = await setup();
      const first = await workspaceRuntime(
        s.target,
        "ensure",
        s.directory,
        s.runner,
      );
      const file = join(
        s.directory,
        "workspaces",
        `${workspaceKey(s.target)}.json`,
      );
      const contents = JSON.stringify({
        target: { ...s.target, ...extra },
        services: first.services,
        appEnvironment: [],
      });
      await writeFile(file, contents);
      const before = s.calls.length;
      await expect(
        workspaceRuntime(s.target, "status", s.directory, s.runner),
      ).rejects.toThrow();
      expect(s.calls).toHaveLength(before);
      expect(await readFile(file, "utf8")).toBe(contents);
    },
  );
  it("rejects transient request fields before persisting a fresh manifest", async () => {
    const s = await setup();
    const request = { ...s.target, action: "ensure" };
    await expect(
      workspaceRuntime(request, "ensure", s.directory, s.runner),
    ).rejects.toThrow();
    expect(s.containers.size).toBe(0);
    const file = join(
      s.directory,
      "workspaces",
      `${workspaceKey(s.target)}.json`,
    );
    await expect(readFile(file, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("requires explicit replacement when a restored worktree moves, while keeping its data volume", async () => {
    const s = await setup();
    const first = await workspaceRuntime(
      s.target,
      "ensure",
      s.directory,
      s.runner,
    );
    const restored = await setup();
    const moved = { ...s.target, path: restored.directory };
    await expect(
      workspaceRuntime(moved, "ensure", s.directory, s.runner),
    ).rejects.toThrow("path changed");
    const replaced = await workspaceRuntime(
      moved,
      "recreate",
      s.directory,
      s.runner,
    );
    expect(replaced.path).toBe(restored.directory);
    expect(replaced.services[0]!.volumes).toEqual(first.services[0]!.volumes);
    const app = replaced.services.find((v) => v.name === "app")!;
    expect(
      s.calls.filter((v) => v[0] === "run" && v.includes(app.id)).at(-1),
    ).toContain(`type=bind,source=${restored.directory},target=/workspace`);
  });
  it("does not silently replace an app when a service address changes", async () => {
    const s = await setup();
    const first = await workspaceRuntime(
      s.target,
      "ensure",
      s.directory,
      s.runner,
    );
    s.containers.get(first.services[0]!.id)!.status.networks = [
      { ipv4Address: "192.168.64.222/24" },
    ];
    const before = s.calls.length;
    await expect(
      workspaceRuntime(s.target, "ensure", s.directory, s.runner),
    ).rejects.toThrow("Apply saved setup");
    expect(
      s.calls.slice(before).some((v) => v[0] === "stop" || v[0] === "delete"),
    ).toBe(false);
  });
  it("reuses one instance across concurrent callers and gives another worktree separate containers, ports and data", async () => {
    const s = await setup();
    const [first, same] = await Promise.all([
      workspaceRuntime(s.target, "ensure", s.directory, s.runner),
      workspaceRuntime(s.target, "ensure", s.directory, s.runner),
    ]);
    expect(same.services).toEqual(first.services);
    expect(s.calls.filter((v) => v[0] === "run")).toHaveLength(2);
    const other = await workspaceRuntime(
      { ...s.target, environmentId: "environment-b" },
      "ensure",
      s.directory,
      s.runner,
    );
    expect(other.services[0]!.id).not.toBe(first.services[0]!.id);
    expect(other.services[0]!.volumes).not.toEqual(first.services[0]!.volumes);
    expect(
      new Set(
        [...first.services, ...other.services].flatMap((v) =>
          v.ports.map((p) => p.host),
        ),
      ).size,
    ).toBe(4);
    const appArgs = s.calls.find(
      (v) => v[0] === "run" && v.includes(first.services[1]!.id),
    )!;
    expect(appArgs).toContain("DATABASE_HOST=192.168.64.2");
    expect(appArgs).toContain(
      `BB_WORKSPACE_PORT_3000=${first.services[1]!.ports[0]!.host}`,
    );
    const otherAppArgs = s.calls.find(
      (v) => v[0] === "run" && v.includes(other.services[1]!.id),
    )!;
    expect(otherAppArgs).toContain(
      `BB_WORKSPACE_PORT_3000=${other.services[1]!.ports[0]!.host}`,
    );
    const databaseArgs = s.calls.find(
      (v) => v[0] === "run" && v.includes(first.services[0]!.id),
    )!;
    expect(databaseArgs.some((v) => v.startsWith("BB_WORKSPACE_PORT_"))).toBe(
      false,
    );
    expect(appArgs).toContain(
      `type=bind,source=${s.directory},target=/workspace`,
    );
    expect(appArgs).toContain(
      `127.0.0.1:${first.services[1]!.ports[0]!.host}:3000`,
    );
  });
  it("stops and recreates only the selected workspace's containers while preserving its database volume", async () => {
    const s = await setup();
    const first = await workspaceRuntime(
      s.target,
      "ensure",
      s.directory,
      s.runner,
    );
    const other = await workspaceRuntime(
      { ...s.target, environmentId: "other" },
      "ensure",
      s.directory,
      s.runner,
    );
    const stopped = await workspaceRuntime(
      s.target,
      "stop",
      s.directory,
      s.runner,
    );
    expect(stopped.services.every((v) => v.state === "stopped")).toBe(true);
    expect(s.containers.get(other.services[0]!.id)!.status.state).toBe(
      "running",
    );
    const recreated = await workspaceRuntime(
      s.target,
      "recreate",
      s.directory,
      s.runner,
    );
    expect(recreated.services[0]!.volumes).toEqual(first.services[0]!.volumes);
    expect(s.calls.some((v) => v[0] === "volume" && v[1] === "delete")).toBe(
      false,
    );
  });
  it("recovers a CLI timeout by inspecting the recorded instance before creating anything again", async () => {
    const s = await setup();
    s.setUnknownRun();
    await expect(
      workspaceRuntime(s.target, "ensure", s.directory, s.runner),
    ).rejects.toThrow("unknown");
    const resumed = await workspaceRuntime(
      s.target,
      "ensure",
      s.directory,
      s.runner,
    );
    expect(resumed.services.every((v) => v.state === "running")).toBe(true);
    expect(s.calls.filter((v) => v[0] === "run")).toHaveLength(2);
  });
  it("refuses a conflicting resource even if external control is enabled elsewhere", async () => {
    const s = await setup();
    const first = await workspaceRuntime(
      s.target,
      "ensure",
      s.directory,
      s.runner,
    );
    s.containers.get(first.services[0]!.id)!.configuration.labels = {};
    const before = s.calls.length;
    await expect(
      workspaceRuntime(s.target, "stop", s.directory, s.runner),
    ).rejects.toThrow("another workspace");
    expect(s.calls.slice(before).some((v) => v[0] === "stop")).toBe(false);
  });
  it("does not treat an unavailable inventory as an empty workspace", async () => {
    const s = await setup();
    await workspaceRuntime(s.target, "ensure", s.directory, s.runner);
    s.setFailInventory();
    const before = s.calls.length;
    await expect(
      workspaceRuntime(s.target, "ensure", s.directory, s.runner),
    ).rejects.toThrow("offline");
    expect(s.calls.slice(before).some((v) => v[0] === "run")).toBe(false);
  });
  it("validates secret-file paths before creating resources and never persists their contents", async () => {
    const s = await setup();
    const outside = await mkdtemp(join(tmpdir(), "bb-workspace-outside-"));
    directories.push(outside);
    await writeFile(
      join(outside, "private.env"),
      "PASSWORD=test-private-value",
    );
    await symlink(
      join(outside, "private.env"),
      join(s.directory, "escape.env"),
    );
    const invalid = {
      ...s.target,
      profile: {
        ...s.target.profile,
        app: { ...s.target.profile.app, envFile: "escape.env" },
      },
    };
    await expect(
      workspaceRuntime(invalid, "ensure", s.directory, s.runner),
    ).rejects.toThrow("inside this workspace");
    expect(s.calls).toHaveLength(0);
    await writeFile(
      join(s.directory, "local.env"),
      "PASSWORD=test-private-value",
    );
    await workspaceRuntime(
      {
        ...invalid,
        profile: {
          ...invalid.profile,
          app: { ...invalid.profile.app, envFile: "local.env" },
        },
      },
      "ensure",
      s.directory,
      s.runner,
    );
    expect(JSON.stringify(s.calls)).not.toContain("test-private-value");
    expect(
      s.calls.find((v) => v[0] === "run" && v.includes("--env-file")),
    ).toContain(join(s.directory, "local.env"));
  });
  it("waits for database readiness before starting the app and detects an exited database", async () => {
    const s = await setup();
    const target = {
      ...s.target,
      profile: {
        ...s.target.profile,
        services: s.target.profile.services.map((v) => ({
          ...v,
          ready: ["database-ready"],
        })),
      },
    };
    let checks = 0;
    const runner: Runner = async (args, timeout, signal) => {
      if (args[0] === "exec" && args.includes("database-ready")) {
        checks++;
        expect(s.calls.filter((v) => v[0] === "run")).toHaveLength(1);
        if (checks === 1) return { ...success(), ok: false, exitCode: 1 };
      }
      return s.runner(args, timeout, signal);
    };
    await workspaceRuntime(target, "ensure", s.directory, runner);
    expect(checks).toBe(2);
    const second = await setup();
    const failing: Runner = async (args, timeout, signal) => {
      if (args[0] === "exec") {
        for (const value of second.containers.values())
          value.status.state = "stopped";
        return { ...success(), ok: false, exitCode: 1 };
      }
      return second.runner(args, timeout, signal);
    };
    await expect(
      workspaceRuntime(
        { ...target, path: second.directory },
        "ensure",
        second.directory,
        failing,
      ),
    ).rejects.toThrow("exited before becoming ready");
    expect(second.calls.filter((v) => v[0] === "run")).toHaveLength(1);
  });
});
