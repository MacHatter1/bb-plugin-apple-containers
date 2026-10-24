import { describe, expect, it, vi } from "vitest";
import { commandSchema, runSchema } from "../contract";
import {
  commandArgs,
  parseArray,
  perform,
  snapshot,
  summariseContainer,
  MANAGED_LABEL,
  WORKSPACE_LABEL,
} from "../lib/runtime";
import { container, success } from "./fixtures";
const config = { binaryPath: "", allowExternal: false };

describe("runtime boundary and command policy", () => {
  it("passes guest scripts literally, binds ports to loopback and defaults mounts to read-only", () => {
    const command = runSchema.parse({
      op: "run",
      name: "demo",
      image: "alpine:3.23",
      command: ["sh", "-lc", "echo $(whoami); echo 'hello'"],
      ports: [{ host: 8080, guest: 80 }],
      mounts: [{ source: "/a folder", target: "/workspace" }],
    });
    const args = commandArgs(command);
    expect(args).toContain(
      `type=bind,source=/a folder,target=/workspace,readonly`,
    );
    expect(args).toContain("127.0.0.1:8080:80");
    expect(args).toContain(`${MANAGED_LABEL}=true`);
    expect(args.slice(-3)).toEqual(command.command);
  });
  it.each([
    { op: "stop", id: "--all" },
    { op: "pull", image: "--help" },
    { op: "exec", id: "demo", command: [] },
    { op: "run", name: "demo", image: "alpine", env: ["SECRET"] },
    { op: "run", name: "demo", image: "alpine", memoryMiB: 128 },
    {
      op: "run",
      name: "demo",
      image: "alpine",
      mounts: [{ source: "/a,readonly", target: "/b" }],
    },
    { op: "run", name: "demo", image: "alpine", extraArgs: ["--ssh"] },
    { op: "build", context: "relative", tag: "app" },
  ])("rejects malformed or option-injecting input %o", (value) => {
    expect(commandSchema.safeParse(value).success).toBe(false);
  });
  it.each(["start", "stop", "delete", "exec"])(
    "protects external containers from %s",
    async (op) => {
      const runner = vi.fn(async (_args: string[]) =>
        success(JSON.stringify([container(false)])),
      );
      const command = commandSchema.parse({
        op,
        id: "demo-workspace",
        ...(op === "exec" ? { command: ["true"] } : {}),
      });
      await expect(perform(command, config, runner)).rejects.toThrow(
        "not managed by BB",
      );
      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner.mock.calls[0]?.[0]).toEqual(["inspect", "demo-workspace"]);
    },
  );
  it("allows control after checking ownership and never forces deletion", async () => {
    const runner = vi.fn(async (_args: string[]) =>
      success(JSON.stringify([container()])),
    );
    await perform({ op: "delete", id: "demo-workspace" }, config, runner);
    expect(runner.mock.calls[1]?.[0]).toEqual(["delete", "demo-workspace"]);
  });
  it("allows external reads and honours the explicit operator override", async () => {
    const runner = vi.fn(async (_args: string[]) => success());
    await perform({ op: "logs", id: "external", lines: 200 }, config, runner);
    await perform(
      { op: "stop", id: "external" },
      { ...config, allowExternal: true },
      runner,
    );
    expect(runner.mock.calls.map((c) => c[0])).toEqual([
      ["logs", "-n", "200", "external"],
      ["stop", "external"],
    ]);
  });
  it("refuses clipped or malformed machine-readable data", () => {
    expect(() => parseArray({ ...success("[]"), truncated: true })).toThrow(
      "exceeded",
    );
    expect(() => parseArray(success("{}"))).toThrow("array");
    expect(() => parseArray(success("no JSON"))).toThrow();
  });
  it("normalises the documented configuration/status shape", () => {
    expect(summariseContainer(container())).toMatchObject({
      id: "demo-workspace",
      managed: true,
      state: "running",
      memoryBytes: 1073741824,
    });
  });
  it("retains workspace ownership labels for project grouping", () => {
    const value = container();
    expect(
      summariseContainer({
        ...value,
        configuration: {
          ...value.configuration,
          labels: {
            ...value.configuration.labels,
            [WORKSPACE_LABEL]: "workspace-key",
          },
        },
      }).workspaceKey,
    ).toBe("workspace-key");
    expect(summariseContainer(value).workspaceKey).toBeUndefined();
  });
  it("reports unsupported hosts without launching anything", async () => {
    const runner = vi.fn(async (_args: string[]) => success());
    expect(
      (await snapshot(config, runner, undefined, "linux", "arm64", "6.1"))
        .supported,
    ).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
  it("reports a stopped runtime even when system status exits successfully", async () => {
    const runner = vi.fn(async (_args: string[]) => success("status stopped"));
    expect(
      (await snapshot(config, runner, undefined, "darwin", "arm64", "25.0"))
        .running,
    ).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
  });
  it("keeps successful lists and reports partial read failures", async () => {
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === "--version") return success("1.5.0");
      if (args[0] === "system") return success("FIELD VALUE\nstatus running\n");
      if (args[0] === "list") return success(JSON.stringify([container()]));
      if (args[0] === "volume")
        return {
          ...success(),
          ok: false,
          exitCode: 1,
          stderr: "volume unavailable",
        };
      return success("[]");
    });
    const state = await snapshot(
      config,
      runner,
      undefined,
      "darwin",
      "arm64",
      "25.0",
    );
    expect(state.running).toBe(true);
    expect(state.containers).toHaveLength(1);
    expect(state.warnings).toEqual(["Volumes: volume unavailable"]);
  });
});

it("reads CLI 1.5 image references from configuration and sizes from variants", async () => {
  const runner = async (args: string[]) => {
    if (args[0] === "--version") return success("1.5.0");
    if (args[0] === "system") return success("status running");
    if (args[0] === "image")
      return success(
        JSON.stringify([
          {
            configuration: {
              name: "docker.io/library/alpine:3.23",
              descriptor: { digest: "sha256:image", size: 9218 },
            },
            id: "image",
            variants: [{ size: 4187708 }],
          },
        ]),
      );
    return success("[]");
  };
  const state = await snapshot(
    config,
    runner,
    undefined,
    "darwin",
    "arm64",
    "25.0",
  );
  expect(state.images).toEqual([
    {
      reference: "docker.io/library/alpine:3.23",
      digest: "sha256:image",
      size: 4187708,
    },
  ]);
});
