import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { setTimeout } from "node:timers/promises";
import {
  workspaceStateSchema,
  workspaceSetupProfileSchema,
  workspaceTargetSchema,
  workspaceActionSchema,
  type WorkspaceTarget,
  type WorkspaceState,
  type WorkspaceTeardownOptions,
  type WorkspaceTeardownResult,
} from "./workspace-schema";
import type { Runner } from "./process";
import type { CommandResult } from "../contract";
import {
  MANAGED_LABEL,
  WORKSPACE_LABEL as OWNER,
  parseArray,
  summariseContainer,
} from "./runtime";

const SERVICE = "app.getbb.apple-containers.service";
const resourceSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    configuration: z
      .object({
        id: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const manifestSchema = z
  .object({
    target: workspaceTargetSchema,
    services: workspaceStateSchema.shape.services,
    appEnvironment: z.array(z.string()).default([]),
  })
  .strict();
// Older host calls persisted the request action alongside the stable target.
const storedManifestSchema = manifestSchema.extend({
  target: workspaceTargetSchema.extend({
    action: workspaceActionSchema.optional(),
  }),
});
type Manifest = z.infer<typeof manifestSchema>;
const queues = new Map<string, Promise<unknown>>();
export const workspaceKey = (
  target: Pick<WorkspaceTarget, "projectId" | "environmentId">,
) =>
  createHash("sha256")
    .update(JSON.stringify([target.projectId, target.environmentId]))
    .digest("hex")
    .slice(0, 24);

export async function withWorkspaceLock<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(run);
  queues.set(key, task);
  try {
    return await task;
  } finally {
    if (queues.get(key) === task) queues.delete(key);
  }
}
function checked(result: CommandResult): CommandResult {
  if (!result.ok || result.truncated)
    throw new Error(
      result.truncated
        ? "Workspace operation output was clipped; inspect the container before retrying."
        : result.stderr ||
            result.stdout ||
            `Container CLI exited ${result.exitCode}`,
    );
  return result;
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a workspace port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function save(file: string, manifest: Manifest) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(manifestSchema.parse(manifest)), {
    mode: 0o600,
  });
  await rename(temporary, file);
}
async function readManifest(
  file: string,
  migrate = true,
): Promise<Manifest | null> {
  try {
    const stored = storedManifestSchema.parse(
      JSON.parse(await readFile(file, "utf8")),
    );
    const { action, ...target } = stored.target;
    const manifest = { ...stored, target };
    if (action !== undefined && migrate) await save(file, manifest);
    return manifest;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
export async function readWorkspaceTarget(
  identity: Pick<WorkspaceTarget, "projectId" | "environmentId">,
  dataDir: string,
  signal?: AbortSignal,
): Promise<WorkspaceTarget | null> {
  const key = workspaceKey(identity);
  return withWorkspaceLock(`${dataDir}:${key}`, async () => {
    signal?.throwIfAborted();
    const manifest = await readManifest(
      join(dataDir, "workspaces", `${key}.json`),
      false,
    );
    if (
      manifest &&
      (manifest.target.projectId !== identity.projectId ||
        manifest.target.environmentId !== identity.environmentId)
    )
      throw new Error(
        "Saved workspace identity does not match this environment.",
      );
    return manifest?.target ?? null;
  });
}
// Inventory all resources before the first deletion. Labels, rather than name
// prefixes, also identify resources left by an earlier recipe or partial run.
export async function workspaceTeardown(
  target: WorkspaceTarget,
  options: WorkspaceTeardownOptions,
  dataDir: string,
  runner: Runner,
  signal?: AbortSignal,
): Promise<WorkspaceTeardownResult> {
  const key = workspaceKey(target);
  return withWorkspaceLock(`${dataDir}:${key}`, async () => {
    signal?.throwIfAborted();
    const file = join(dataDir, "workspaces", `${key}.json`);
    const manifest = await readManifest(file, false);
    if (
      manifest &&
      (manifest.target.projectId !== target.projectId ||
        manifest.target.environmentId !== target.environmentId ||
        manifest.target.path !== target.path)
    )
      throw new Error(
        "Workspace identity or path changed; inspect its saved containers before proceeding.",
      );
    const containers = await inventory(runner, signal);
    const networks = parseArray(
      await runner(["network", "list", "--format", "json"], 30_000, signal),
    );
    const volumes = parseArray(
      await runner(["volume", "list", "--format", "json"], 30_000, signal),
    );
    const prefix = `bb-ws-${key}`;
    const recipe = manifest?.target.profile ?? target.profile;
    const definitions = [...recipe.services, recipe.app];
    for (const id of new Set([
      ...(manifest?.services.map((s) => s.id) ?? []),
      ...definitions.map((s) => `${prefix}-${s.name}`),
    ]))
      findOwned(containers, id, key);
    findOwned(networks, prefix, key);
    for (const id of new Set([
      ...(manifest?.services.flatMap((s) => s.volumes) ?? []),
      ...definitions.flatMap((s) =>
        s.volumes.map((v) => `${prefix}-${s.name}-${v.name}`),
      ),
    ]))
      findOwned(volumes, id, key);
    function owned(values: unknown[]) {
      return values.flatMap((value) => {
        const resource = resourceSchema.parse(value);
        const labels = resource.configuration?.labels ?? resource.labels;
        if (labels?.[OWNER] !== key || labels[MANAGED_LABEL] !== "true")
          return [];
        const id = resource.id ?? resource.name ?? resource.configuration?.id;
        // Never pass arbitrary inventory strings as CLI options.
        if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id))
          throw new Error(
            "Owned workspace resource has an invalid identifier; inspect it before cleanup.",
          );
        return [{ id, value }];
      });
    }
    const ownedContainers = owned(containers).sort(
      (a, b) =>
        Number(b.id === `${prefix}-app`) - Number(a.id === `${prefix}-app`),
    );
    const ownedNetworks = owned(networks),
      ownedVolumes = owned(volumes);
    if (
      !manifest &&
      !ownedContainers.length &&
      !ownedNetworks.length &&
      !ownedVolumes.length
    )
      return { kind: "absent", environmentId: target.environmentId };
    const result = {
      kind: options.dryRun ? ("preview" as const) : ("removed" as const),
      environmentId: target.environmentId,
      containers: ownedContainers.map((v) => v.id),
      networks: ownedNetworks.map((v) => v.id),
      volumes: options.removeVolumes ? ownedVolumes.map((v) => v.id) : [],
      retainedVolumes: options.removeVolumes
        ? []
        : ownedVolumes.map((v) => v.id),
    };
    if (options.dryRun) return result;
    for (const { id, value } of ownedContainers) {
      if (summariseContainer(value).state !== "stopped")
        checked(await runner(["stop", id], 60_000, signal));
      checked(await runner(["delete", id], 60_000, signal));
    }
    for (const id of result.volumes)
      checked(await runner(["volume", "delete", id], 60_000, signal));
    for (const id of result.networks)
      checked(await runner(["network", "delete", id], 60_000, signal));
    await rm(file, { force: true });
    return result;
  });
}
async function environmentFile(
  root: string,
  file: string,
): Promise<string | null> {
  if (!file) return null;
  const absolute = await realpath(resolve(root, file));
  const inside = relative(root, absolute);
  if (
    inside === ".." ||
    inside.startsWith("../") ||
    isAbsolute(inside) ||
    !(await stat(absolute)).isFile()
  )
    throw new Error(
      "Environment files must be regular files inside this workspace",
    );
  return absolute;
}
async function inventory(runner: Runner, signal?: AbortSignal) {
  return parseArray(
    await runner(["list", "--all", "--format", "json"], 30_000, signal),
  );
}
function findOwned(values: unknown[], id: string, key: string) {
  const value = values.find((value) => {
    const parsed = resourceSchema.parse(value);
    return (parsed.id ?? parsed.name ?? parsed.configuration?.id) === id;
  });
  if (!value) return null;
  const parsed = resourceSchema.parse(value);
  const labels = parsed.configuration?.labels ?? parsed.labels;
  if (labels?.[OWNER] !== key || labels?.[MANAGED_LABEL] !== "true")
    throw new Error(
      `Resource ${id} belongs to another workspace; it was left untouched.`,
    );
  return value;
}
async function ensureResource(
  kind: "network" | "volume",
  name: string,
  key: string,
  runner: Runner,
  signal?: AbortSignal,
) {
  const values = parseArray(
    await runner([kind, "list", "--format", "json"], 30_000, signal),
  );
  if (findOwned(values, name, key)) return;
  checked(
    await runner(
      [
        kind,
        "create",
        "--label",
        `${MANAGED_LABEL}=true`,
        "--label",
        `${OWNER}=${key}`,
        name,
      ],
      60_000,
      signal,
    ),
  );
}
async function waitReady(
  definition: WorkspaceTarget["profile"]["app"],
  id: string,
  runner: Runner,
  signal?: AbortSignal,
) {
  if (!definition.ready.length) return;
  const deadline = Date.now() + definition.readyTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await runner(
      ["exec", id, ...definition.ready],
      Math.min(10_000, Math.max(1, deadline - Date.now())),
      signal,
    );
    if (result.ok && !result.truncated) return;
    const inspected = parseArray(await runner(["inspect", id], 10_000, signal));
    if (
      inspected.length !== 1 ||
      summariseContainer(inspected[0]).state !== "running"
    )
      throw new Error(
        `Service ${definition.name} exited before becoming ready. Inspect its logs; data volumes are preserved.`,
      );
    await setTimeout(
      Math.min(1000, Math.max(1, deadline - Date.now())),
      undefined,
      { signal },
    );
  }
  throw new Error(
    `Service ${definition.name} did not pass its readiness check. Inspect its logs; existing containers and data have been kept.`,
  );
}
async function freshManifest(target: WorkspaceTarget): Promise<Manifest> {
  const prefix = `bb-ws-${workspaceKey(target)}`;
  const services: Manifest["services"] = [];
  for (const definition of [...target.profile.services, target.profile.app]) {
    const ports = [];
    for (const guest of definition.ports)
      ports.push({ guest, host: await freePort() });
    services.push({
      name: definition.name,
      id: `${prefix}-${definition.name}`,
      state: "missing",
      address: "",
      ports,
      volumes: definition.volumes.map(
        (v) => `${prefix}-${definition.name}-${v.name}`,
      ),
    });
  }
  return { target, services, appEnvironment: [] };
}
async function refresh(
  manifest: Manifest,
  runner: Runner,
  key: string,
  signal?: AbortSignal,
): Promise<WorkspaceState> {
  const values = await inventory(runner, signal);
  const services = manifest.services.map((item) => {
    const value = findOwned(values, item.id, key);
    if (!value) return { ...item, state: "missing", address: "" };
    const summary = summariseContainer(value);
    return {
      ...item,
      state: summary.state,
      address: summary.addresses[0]?.split("/")[0] ?? "",
    };
  });
  manifest.services = services;
  return {
    environmentId: manifest.target.environmentId,
    path: manifest.target.path,
    configured: true,
    services,
  };
}
async function stopServices(
  manifest: Manifest,
  runner: Runner,
  key: string,
  remove: boolean,
  signal?: AbortSignal,
) {
  const values = await inventory(runner, signal);
  const owned = [...manifest.services]
    .reverse()
    .map((item) => ({ item, value: findOwned(values, item.id, key) }));
  for (const { item, value } of owned) {
    if (!value) continue;
    if (summariseContainer(value).state === "running")
      checked(await runner(["stop", item.id], 60_000, signal));
    if (remove) checked(await runner(["delete", item.id], 60_000, signal));
  }
}
export async function workspaceRuntime(
  target: WorkspaceTarget,
  action: "ensure" | "status" | "stop" | "recreate",
  dataDir: string,
  runner: Runner,
  signal?: AbortSignal,
): Promise<WorkspaceState> {
  if (action === "ensure" || action === "recreate")
    workspaceSetupProfileSchema.parse(target.profile);
  const key = workspaceKey(target);
  return withWorkspaceLock(`${dataDir}:${key}`, async () => {
    signal?.throwIfAborted();
    const directory = join(dataDir, "workspaces");
    const file = join(directory, `${key}.json`);
    let manifest = await readManifest(file);
    if (
      manifest &&
      (manifest.target.projectId !== target.projectId ||
        manifest.target.environmentId !== target.environmentId ||
        (manifest.target.path !== target.path && action !== "recreate"))
    )
      throw new Error(
        "Workspace identity or path changed; inspect its saved containers before proceeding.",
      );
    if (action === "status" && !manifest)
      return {
        environmentId: target.environmentId,
        path: target.path,
        configured: false,
        services: [],
      };
    if (action === "stop") {
      if (!manifest)
        return {
          environmentId: target.environmentId,
          path: target.path,
          configured: false,
          services: [],
        };
      await stopServices(manifest, runner, key, false, signal);
      return refresh(manifest, runner, key, signal);
    }
    if (action === "status" && manifest)
      return refresh(manifest, runner, key, signal);
    const root = await realpath(target.path);
    workspaceTargetSchema.shape.path.parse(root);
    if (!(await stat(root)).isDirectory())
      throw new Error("The workspace directory is unavailable");
    // Validate every file before stopping or creating anything. Contents stay on the Mac.
    const files = new Map<string, string | null>();
    for (const definition of [...target.profile.services, target.profile.app])
      files.set(
        definition.name,
        await environmentFile(root, definition.envFile),
      );
    const health = checked(await runner(["system", "status"], 15_000, signal));
    if (!/(?:^|\n)status\s+running\b/.test(health.stdout))
      throw new Error(
        "Start the Apple container service before starting this environment.",
      );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (action === "recreate" && manifest) {
      await stopServices(manifest, runner, key, true, signal);
      manifest = null;
    }
    if (!manifest) {
      manifest = await freshManifest(target);
      await save(file, manifest);
    }
    // An existing instance keeps its saved recipe until the user explicitly recreates it.
    if (
      JSON.stringify(manifest.target.profile) !== JSON.stringify(target.profile)
    )
      throw new Error(
        "This environment uses an earlier setup. Apply the updated setup to recreate its containers; database volumes are preserved.",
      );
    const network = `bb-ws-${key}`;
    await ensureResource("network", network, key, runner, signal);
    const definitions = [...target.profile.services, target.profile.app];
    const connectionsDirectory = join(directory, `${key}-connections`);
    const usesConnections = definitions.some((v) => v.mountWorkspace);
    const updateConnections = async () => {
      const state = await refresh(manifest, runner, key, signal);
      if (usesConnections) {
        await mkdir(connectionsDirectory, { recursive: true, mode: 0o700 });
        const file = join(connectionsDirectory, "services.json");
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
        await rename(temporary, file);
      }
    };
    for (const [index, definition] of definitions.entries()) {
      const item = manifest.services.find((v) => v.name === definition.name);
      if (!item) throw new Error("Saved workspace service is missing");
      let environment: string[] = [];
      if (definition.name === "app" || definition.mountWorkspace) {
        await updateConnections();
        const predecessors = new Set(
          definitions.slice(0, index).map((v) => v.name),
        );
        environment = manifest.services
          .filter((v) => predecessors.has(v.name))
          .flatMap((v) => {
            if (!v.address || v.state !== "running")
              throw new Error(
                `Service ${v.name} is not running; inspect its logs.`,
              );
            const variable = v.name.toUpperCase().replaceAll("-", "_");
            return [
              `${variable}_HOST=${v.address}`,
              ...(v.ports[0] ? [`${variable}_PORT=${v.ports[0].guest}`] : []),
              ...(definition.mountWorkspace && v.ports[0]
                ? [`${variable}_PUBLISHED_PORT=${v.ports[0].host}`]
                : []),
            ];
          });
      }
      let value = findOwned(await inventory(runner, signal), item.id, key);
      if (
        value &&
        definition.name === "app" &&
        !definition.mountWorkspace &&
        JSON.stringify(environment) !== JSON.stringify(manifest.appEnvironment)
      ) {
        throw new Error(
          "Service addresses changed. Apply saved setup to reconnect the app; named data volumes are preserved.",
        );
      }
      if (value) {
        if (summariseContainer(value).state !== "running")
          checked(await runner(["start", item.id], 60_000, signal));
        await updateConnections();
        await waitReady(definition, item.id, runner, signal);
        continue;
      }
      for (const volume of item.volumes)
        await ensureResource("volume", volume, key, runner, signal);
      if (definition.name === "app") {
        manifest.appEnvironment = environment;
        await save(file, manifest);
      }
      const env = files.get(definition.name);
      const args = [
        "run",
        "--detach",
        "--name",
        item.id,
        "--label",
        `${MANAGED_LABEL}=true`,
        "--label",
        `${OWNER}=${key}`,
        "--label",
        `${SERVICE}=${definition.name}`,
        "--network",
        network,
        "--cpus",
        String(definition.cpus),
        "--memory",
        `${definition.memoryMiB}M`,
        ...(env ? ["--env-file", env] : []),
        ...environment.flatMap((v) => ["--env", v]),
        ...(definition.name === "app" || definition.mountWorkspace
          ? item.ports.flatMap((v) => [
              "--env",
              `BB_WORKSPACE_PORT_${v.guest}=${v.host}`,
            ])
          : []),
        ...item.ports.flatMap((v) => [
          "--publish",
          `127.0.0.1:${v.host}:${v.guest}`,
        ]),
        ...(definition.name === "app" || definition.mountWorkspace
          ? [
              "--mount",
              `type=bind,source=${root},target=/workspace`,
              "--workdir",
              "/workspace",
            ]
          : []),
        ...(definition.mountWorkspace
          ? [
              "--mount",
              `type=bind,source=${connectionsDirectory},target=/run/bb-workspace,readonly`,
              "--env",
              "BB_WORKSPACE_SERVICES_FILE=/run/bb-workspace/services.json",
            ]
          : []),
        ...definition.volumes.flatMap((v, i) => [
          "--mount",
          `type=volume,source=${item.volumes[i]},target=${v.target}`,
        ]),
        definition.image,
        ...definition.command,
      ];
      checked(await runner(args, 600_000, signal));
      await updateConnections();
      await waitReady(definition, item.id, runner, signal);
    }
    const state = await refresh(manifest, runner, key, signal);
    await save(file, manifest);
    if (state.services.some((v) => v.state !== "running"))
      throw new Error(
        "A workspace container exited during startup. Inspect its logs in Containers; data volumes are preserved.",
      );
    return state;
  });
}
