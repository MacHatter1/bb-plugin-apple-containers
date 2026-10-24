import { randomUUID } from "node:crypto";
import type { ContainerOwner } from "../contract";

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
const ownerKey = (owner: ContainerOwner) =>
  JSON.stringify([owner.projectId, owner.threadId]);
export function ownerBusy(owner: ContainerOwner) {
  return operations.has(ownerKey(owner));
}
export async function withOwnerLock<T>(
  owner: ContainerOwner,
  run: () => Promise<T>,
): Promise<T> {
  const key = ownerKey(owner);
  const previous = operations.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(run);
  operations.set(key, task);
  try {
    return await task;
  } finally {
    if (operations.get(key) === task) operations.delete(key);
  }
}
