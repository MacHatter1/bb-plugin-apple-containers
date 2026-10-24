import { randomUUID } from "node:crypto";
import type { ContainerOwner } from "../contract";
import type { Runner } from "./process";

export const THREAD_LABEL = "app.getbb.apple-containers.thread";
export const PROJECT_LABEL = "app.getbb.apple-containers.project";
export const ENVIRONMENT_LABEL = "app.getbb.apple-containers.environment";
export const CLEANUP_LABEL = "app.getbb.apple-containers.cleanup";
export const INSTANCE_LABEL = "app.getbb.apple-containers.instance";

export function ownershipArgs(
  owner: ContainerOwner,
  cleanup: "task" | "manual",
) {
  return [
    [THREAD_LABEL, owner.threadId],
    [PROJECT_LABEL, owner.projectId],
    ...(owner.environmentId ? [[ENVIRONMENT_LABEL, owner.environmentId]] : []),
    [CLEANUP_LABEL, cleanup],
    [INSTANCE_LABEL, randomUUID()],
  ].flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

const operations = new Map<string, Promise<unknown>>();
const containerOperations = new Map<string, Promise<unknown>>();
const ownerKey = (owner: ContainerOwner) =>
  JSON.stringify([owner.projectId, owner.threadId]);
export function ownerBusy(owner: ContainerOwner) {
  return operations.has(ownerKey(owner));
}
export async function withOwnerLock<T>(
  owner: ContainerOwner,
  run: () => Promise<T>,
): Promise<T> {
  return withLock(operations, ownerKey(owner), run);
}

/** Serialise name-based lifecycle operations with reclaim's inspect/delete pair. */
export async function withContainerLock<T>(id: string, run: () => Promise<T>) {
  return withLock(containerOperations, id, run);
}

/** Workspace commands share name locks with standalone lifecycle and reclaim. */
export function lockContainerCommands(runner: Runner): Runner {
  return (args, timeout, signal) => {
    const nameIndex = args[0] === "run" ? args.indexOf("--name") : -1;
    const id =
      nameIndex >= 0
        ? args[nameIndex + 1]
        : ["start", "stop", "delete"].includes(args[0] ?? "")
          ? args[1]
          : undefined;
    const run = () => runner(args, timeout, signal);
    return id ? withContainerLock(id, run) : run();
  };
}

async function withLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(run);
  locks.set(key, task);
  try {
    return await task;
  } finally {
    if (locks.get(key) === task) locks.delete(key);
  }
}
