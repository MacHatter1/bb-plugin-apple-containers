import {
  containerId,
  type ContainerOwner,
  type ContainerCleanupResult,
} from "../contract";
import type { Runner } from "./process";
import {
  MANAGED_LABEL,
  WORKSPACE_LABEL,
  parseArray,
  summariseContainer,
} from "./runtime";
import {
  CLEANUP_LABEL,
  INSTANCE_LABEL,
  PROJECT_LABEL,
  THREAD_LABEL,
  ownerBusy,
  withOwnerLock,
  withContainerLock,
} from "./container-ownership";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function identity(value: unknown) {
  const root = record(value);
  const labels = record(record(root.configuration).labels);
  return { ...summariseContainer(value), labels };
}

/** Cleanup is independent of server memory, so a lost response or reload is retryable. */
export async function cleanupAgentContainers(
  owner: ContainerOwner,
  dryRun: boolean,
  runner: Runner,
  signal?: AbortSignal,
): Promise<ContainerCleanupResult> {
  const result: ContainerCleanupResult = {
    kind: "removed",
    planned: [],
    removed: [],
    retained: [],
    errors: [],
  };
  if (ownerBusy(owner)) return { ...result, kind: "busy" };
  return withOwnerLock(owner, async () => {
    const read = async () =>
      parseArray(
        await runner(["list", "--all", "--format", "json"], 30_000, signal),
      ).map(identity);
    const owns = (item: ReturnType<typeof identity>) =>
      item.labels[MANAGED_LABEL] === "true" &&
      item.labels[THREAD_LABEL] === owner.threadId &&
      item.labels[PROJECT_LABEL] === owner.projectId &&
      typeof item.labels[INSTANCE_LABEL] === "string" &&
      !!item.labels[INSTANCE_LABEL] &&
      !item.labels[WORKSPACE_LABEL];
    const inventory = await read();
    const targets = inventory.filter(
      (item) => owns(item) && item.labels[CLEANUP_LABEL] === "task",
    );
    result.retained = inventory
      .filter((item) => owns(item) && item.labels[CLEANUP_LABEL] === "manual")
      .map((item) => item.id);
    result.planned = targets.map((item) => containerId.parse(item.id));
    if (dryRun) return { ...result, kind: "preview" };
    for (const target of targets) {
      try {
        await withContainerLock(target.id, async () => {
          signal?.throwIfAborted();
          const current = async () => {
            const item = (await read()).find((item) => item.id === target.id);
            if (
              item &&
              (!owns(item) ||
                item.labels[CLEANUP_LABEL] !== "task" ||
                item.labels[INSTANCE_LABEL] !== target.labels[INSTANCE_LABEL])
            )
              throw new Error("Container ownership changed; left untouched.");
            return item;
          };
          let item = await current();
          if (item?.state === "running") {
            const stopped = await runner(["stop", target.id], 60_000, signal);
            item = await current();
            if (item && item.state !== "stopped")
              throw new Error(
                stopped.stderr ||
                  stopped.stdout ||
                  "Container did not stop; retry cleanup after inspecting it.",
              );
          }
          if (item) {
            if (item.state !== "stopped")
              throw new Error(
                `Container is ${item.state}; retry cleanup after it settles.`,
              );
            const deleted = await runner(["delete", target.id], 60_000, signal);
            if (await current())
              throw new Error(
                deleted.stderr ||
                  deleted.stdout ||
                  "Container is still present; retry cleanup.",
              );
          }
          result.removed.push(target.id);
        });
      } catch (cause) {
        result.errors.push({
          id: target.id,
          message: String(cause instanceof Error ? cause.message : cause).slice(
            0,
            2000,
          ),
        });
      }
    }
    return { ...result, kind: result.errors.length ? "partial" : "removed" };
  });
}
