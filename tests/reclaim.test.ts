import { expect, it, vi } from "vitest";
import { perform } from "../lib/runtime";
import { INSTANCE_LABEL, THREAD_LABEL } from "../lib/container-ownership";
import { container, success } from "./fixtures";
import { runSchema } from "../contract";
import { lockContainerCommands } from "../lib/container-ownership";

const config = { binaryPath: "", allowExternal: false };
const reclaim = {
  op: "reclaim",
  target: "stopped-containers",
  confirmed: true,
} as const;
function stopped(id: string) {
  const value = container();
  return {
    ...value,
    id,
    configuration: {
      ...value.configuration,
      labels: { ...value.configuration.labels } as Record<string, string>,
    },
    status: { ...value.status, state: "stopped" },
  };
}

it.each(["external", "instance", "creation", "owner", "running"])(
  "preserves a %s replacement made while an earlier container is reclaimed",
  async (change) => {
    const first = stopped("first"),
      second = stopped("second");
    const replacement = structuredClone(second);
    if (change === "external") replacement.configuration.labels = {};
    if (change === "instance")
      replacement.configuration.labels[INSTANCE_LABEL] = "replacement";
    if (change === "creation")
      replacement.configuration.creationDate = "2026-10-24T00:00:00Z";
    if (change === "owner")
      replacement.configuration.labels[THREAD_LABEL] = "another-thread";
    if (change === "running") replacement.status.state = "running";
    const containers = new Map([
      [first.id, first],
      [second.id, second],
    ]);
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === "list")
        return success(JSON.stringify([...containers.values()]));
      if (args[0] === "inspect")
        return success(
          JSON.stringify([containers.get(args[1]!)].filter(Boolean)),
        );
      if (args[0] === "delete") {
        containers.delete(args[1]!);
        if (args[1] === first.id) containers.set(second.id, replacement);
        return success();
      }
      throw new Error(`Unexpected command ${args}`);
    });
    await expect(perform(reclaim, config, runner)).rejects.toThrow(
      /changed|stopped/i,
    );
    expect(containers.get(second.id)).toEqual(replacement);
    expect(
      runner.mock.calls
        .filter(([args]) => args[0] === "delete")
        .map(([args]) => args),
    ).toEqual([["delete", first.id]]);
  },
);

it("reclaims unchanged stopped managed containers, including older containers without instance labels", async () => {
  const value = stopped("older");
  const runner = vi.fn(async (args: string[]) =>
    args[0] === "delete" ? success() : success(JSON.stringify([value])),
  );
  expect(await perform(reclaim, config, runner)).toMatchObject({
    ok: true,
    stdout: expect.stringContaining("Removed 1 stopped"),
  });
  expect(runner.mock.calls.map(([args]) => args)).toEqual([
    ["list", "--all", "--format", "json"],
    ["inspect", "older"],
    ["delete", "older"],
  ]);
});

it.each(["standalone", "workspace"])(
  "serialises reclaim with a same-name %s launch",
  async (source) => {
    const value = stopped("same-name");
    let release!: () => void, inspected!: () => void;
    const inspection = new Promise<void>((resolve) => {
      inspected = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === "list") return success(JSON.stringify([value]));
      if (args[0] === "inspect") {
        inspected();
        await gate;
        return success(JSON.stringify([value]));
      }
      return success();
    });
    const cleanup = perform(reclaim, config, runner);
    await inspection;
    const command = runSchema.parse({
      op: "run",
      name: value.id,
      image: "alpine",
    });
    const launch =
      source === "workspace"
        ? lockContainerCommands(runner)(
            ["run", "--name", value.id, "alpine"],
            60_000,
          )
        : perform(command, config, runner);
    await Promise.resolve();
    expect(runner.mock.calls.some(([args]) => args[0] === "run")).toBe(false);
    release();
    await cleanup;
    await launch;
    expect(runner.mock.calls.map(([args]) => args[0])).toEqual([
      "list",
      "inspect",
      "delete",
      "run",
    ]);
  },
);

it.each(["missing", "clipped", "failed", "unidentifiable"])(
  "never deletes after a %s identity read",
  async (mode) => {
    const value = stopped("unsafe");
    if (mode === "unidentifiable") value.configuration.creationDate = "";
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === "list") return success(JSON.stringify([value]));
      if (args[0] === "inspect")
        return {
          ...success(JSON.stringify(mode === "missing" ? [] : [value])),
          ...(mode === "clipped" ? { truncated: true } : {}),
          ...(mode === "failed"
            ? { ok: false, exitCode: 1, stderr: "offline" }
            : {}),
        };
      return success();
    });
    await expect(perform(reclaim, config, runner)).rejects.toThrow();
    expect(runner.mock.calls.some(([args]) => args[0] === "delete")).toBe(
      false,
    );
  },
);
