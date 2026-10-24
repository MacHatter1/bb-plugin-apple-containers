import { expect, it, vi } from "vitest";
import { cleanupAgentContainers } from "../lib/agent-containers";
import {
  commandArgs,
  summariseContainer,
  WORKSPACE_LABEL,
} from "../lib/runtime";
import {
  CLEANUP_LABEL,
  INSTANCE_LABEL,
  PROJECT_LABEL,
  THREAD_LABEL,
  withOwnerLock,
} from "../lib/container-ownership";
import { runSchema } from "../contract";
import { container, success } from "./fixtures";

const owner = {
  threadId: "thread-a",
  projectId: "project-a",
  environmentId: "env-a",
};
function owned(id: string, labels: Record<string, string> = {}) {
  const value = container();
  return {
    ...value,
    id,
    configuration: {
      ...value.configuration,
      labels: {
        ...value.configuration.labels,
        [THREAD_LABEL]: owner.threadId,
        [PROJECT_LABEL]: owner.projectId,
        [CLEANUP_LABEL]: "task",
        [INSTANCE_LABEL]: `instance-${id}`,
        ...labels,
      },
    },
  };
}
function runtime(values: ReturnType<typeof owned>[]) {
  const containers = new Map(values.map((value) => [value.id, value]));
  const runner = vi.fn(async (args: string[]) => {
    if (args[0] === "list")
      return success(JSON.stringify([...containers.values()]));
    if (args[0] === "stop") containers.get(args[1]!)!.status.state = "stopped";
    else if (args[0] === "delete") containers.delete(args[1]!);
    else throw new Error(`Unexpected command ${args}`);
    return success();
  });
  return { runner, containers };
}

it("tags new task and manual containers with durable ownership and distinct instance IDs", () => {
  const command = runSchema.parse({ op: "run", name: "task", image: "alpine" });
  const first = commandArgs(command, owner);
  expect(first).toContain(`${THREAD_LABEL}=thread-a`);
  expect(first).toContain(`${PROJECT_LABEL}=project-a`);
  expect(first).toContain(`${CLEANUP_LABEL}=task`);
  expect(first.find((v) => v.startsWith(`${INSTANCE_LABEL}=`))).not.toBe(
    commandArgs(command, owner).find((v) => v.startsWith(`${INSTANCE_LABEL}=`)),
  );
  expect(commandArgs({ ...command, cleanup: "manual" }, owner)).toContain(
    `${CLEANUP_LABEL}=manual`,
  );
  expect(summariseContainer(owned("task"))).toMatchObject({
    ownerThreadId: "thread-a",
    projectId: "project-a",
  });
});

it("previews only this thread's task containers and retains manual, legacy and shared resources", async () => {
  const s = runtime([
    owned("task"),
    owned("keep", { [CLEANUP_LABEL]: "manual" }),
    owned("other-thread", { [THREAD_LABEL]: "thread-b" }),
    owned("other-project", { [PROJECT_LABEL]: "project-b" }),
    owned("workspace", { [WORKSPACE_LABEL]: "workspace-key" }),
    owned("legacy", { [INSTANCE_LABEL]: "" }),
  ]);
  expect(await cleanupAgentContainers(owner, true, s.runner)).toMatchObject({
    kind: "preview",
    planned: ["task"],
    retained: ["keep"],
    removed: [],
  });
  expect(s.runner.mock.calls.every(([args]) => args[0] === "list")).toBe(true);
  expect(await cleanupAgentContainers(owner, false, s.runner)).toMatchObject({
    kind: "removed",
    removed: ["task"],
    retained: ["keep"],
  });
  expect([...s.containers.keys()]).toEqual([
    "keep",
    "other-thread",
    "other-project",
    "workspace",
    "legacy",
  ]);
  expect(await cleanupAgentContainers(owner, false, s.runner)).toMatchObject({
    kind: "removed",
    planned: [],
    removed: [],
  });
  expect(
    s.runner.mock.calls
      .filter(([args]) => args[0] !== "list")
      .map(([args]) => args),
  ).toEqual([
    ["stop", "task"],
    ["delete", "task"],
  ]);
});

it("reports a failed deletion while cleaning other owned containers and succeeds on retry", async () => {
  const s = runtime([owned("one"), owned("two")]);
  const original = s.runner.getMockImplementation()!;
  s.runner.mockImplementation(async (args) =>
    args[0] === "delete" && args[1] === "one"
      ? { ...success(), ok: false, exitCode: 1, stderr: "busy" }
      : original(args),
  );
  const result = await cleanupAgentContainers(owner, false, s.runner);
  expect(result).toMatchObject({
    kind: "partial",
    removed: ["two"],
    errors: [{ id: "one", message: "busy" }],
  });
  s.runner.mockImplementation(original);
  expect(await cleanupAgentContainers(owner, false, s.runner)).toMatchObject({
    kind: "removed",
    removed: ["one"],
  });
  expect(s.containers.size).toBe(0);
});

it("reconciles a lost stop/delete outcome from observed state", async () => {
  const s = runtime([owned("task")]);
  const original = s.runner.getMockImplementation()!;
  s.runner.mockImplementation(async (args) => {
    const result = await original(args);
    return args[0] === "list"
      ? result
      : { ...success(), ok: false, exitCode: 124, stderr: "response lost" };
  });
  expect(await cleanupAgentContainers(owner, false, s.runner)).toMatchObject({
    kind: "removed",
    removed: ["task"],
    errors: [],
  });
});

it("never deletes a still-running container after stop fails", async () => {
  const s = runtime([owned("task")]);
  const original = s.runner.getMockImplementation()!;
  s.runner.mockImplementation(async (args) =>
    args[0] === "stop"
      ? { ...success(), ok: false, exitCode: 1, stderr: "stop failed" }
      : original(args),
  );
  expect(await cleanupAgentContainers(owner, false, s.runner)).toMatchObject({
    kind: "partial",
    removed: [],
    errors: [{ id: "task", message: "stop failed" }],
  });
  expect(s.runner.mock.calls.some(([args]) => args[0] === "delete")).toBe(
    false,
  );
});

it.each(["before-stop", "before-delete"])(
  "preserves replacements when ownership changes %s",
  async (phase) => {
    const s = runtime([owned("task")]);
    const original = s.runner.getMockImplementation()!;
    let reads = 0;
    s.runner.mockImplementation(async (args) => {
      if (args[0] === "list" && ++reads === (phase === "before-stop" ? 2 : 3))
        s.containers.set(
          "task",
          owned("task", { [INSTANCE_LABEL]: "replacement" }),
        );
      return original(args);
    });
    expect(await cleanupAgentContainers(owner, false, s.runner)).toMatchObject({
      kind: "partial",
      removed: [],
      errors: [
        { id: "task", message: expect.stringContaining("ownership changed") },
      ],
    });
    expect(s.containers.has("task")).toBe(true);
    expect(s.runner.mock.calls.some(([args]) => args[0] === "delete")).toBe(
      false,
    );
  },
);

it("defers cleanup during an owned command and allows retry once it finishes", async () => {
  const s = runtime([owned("task")]);
  let finish!: () => void;
  const operation = withOwnerLock(
    owner,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  expect(await cleanupAgentContainers(owner, false, s.runner)).toMatchObject({
    kind: "busy",
  });
  expect(s.runner).not.toHaveBeenCalled();
  finish();
  await operation;
  expect(await cleanupAgentContainers(owner, false, s.runner)).toMatchObject({
    kind: "removed",
    removed: ["task"],
  });
});

it("refuses clipped or failed inventory without mutating any container", async () => {
  const runner = vi.fn(async () => ({ ...success("[]"), truncated: true }));
  await expect(cleanupAgentContainers(owner, false, runner)).rejects.toThrow(
    "exceeded",
  );
  expect(runner).toHaveBeenCalledTimes(1);
});
