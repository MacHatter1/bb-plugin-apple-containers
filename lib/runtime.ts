import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { release } from "node:os";
import { containerId, diskUsageSchema, type DiskUsage } from "../contract";
import type {
  CommandResult,
  ContainerCommand,
  ContainerSummary,
  RuntimeConfig,
  Snapshot,
  Metrics,
  ContainerOwner,
} from "../contract";
import {
  ownershipArgs,
  PROJECT_LABEL,
  THREAD_LABEL,
  INSTANCE_LABEL,
  withContainerLock,
} from "./container-ownership";
import { runProcess, type Runner } from "./process";
import { MANAGED_LABEL, runArgs } from "./run-args";
import { timeoutFor } from "./timeout";

export { MANAGED_LABEL };
export const WORKSPACE_LABEL = "app.getbb.apple-containers.workspace";
type RecordValue = Record<string, unknown>;
const obj = (v: unknown): RecordValue =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as RecordValue)
    : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseArray(result: CommandResult): unknown[] {
  if (!result.ok)
    throw new Error(
      result.stderr ||
        result.stdout ||
        `Container CLI exited ${result.exitCode}`,
    );
  if (result.truncated)
    throw new Error(
      "Container JSON exceeded the output limit; narrow the request using the native CLI.",
    );
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed))
    throw new Error("Expected an array from the Apple container CLI.");
  return parsed;
}
export function parseDiskUsage(result: CommandResult): DiskUsage {
  if (!result.ok)
    throw new Error(
      result.stderr ||
        result.stdout ||
        `Container CLI exited ${result.exitCode}`,
    );
  if (result.truncated)
    throw new Error(
      "Storage usage output exceeded the output limit; narrow the request using the native CLI.",
    );
  return diskUsageSchema.parse(JSON.parse(result.stdout));
}
export function summariseContainer(value: unknown): ContainerSummary {
  const root = obj(value),
    config = obj(root.configuration),
    status = obj(root.status),
    resources = obj(config.resources),
    workspaceKey = str(obj(config.labels)[WORKSPACE_LABEL]),
    projectId = str(obj(config.labels)[PROJECT_LABEL]),
    ownerThreadId = str(obj(config.labels)[THREAD_LABEL]);
  return {
    id: str(root.id) || str(config.id),
    image: str(obj(config.image).reference),
    state: str(status.state) || str(root.status) || "unknown",
    managed: obj(config.labels)[MANAGED_LABEL] === "true",
    ...(workspaceKey ? { workspaceKey } : {}),
    ...(projectId ? { projectId } : {}),
    ...(ownerThreadId ? { ownerThreadId } : {}),
    cpus: num(resources.cpus),
    memoryBytes: num(resources.memoryInBytes),
    createdAt: str(config.creationDate),
    addresses: array(status.networks).flatMap((n) => {
      const item = obj(n);
      return [str(item.ipv4Address), str(item.ipv6Address)].filter(Boolean);
    }),
    ports: array(config.publishedPorts).map((p) => {
      const port = obj(p);
      return `${str(port.hostAddress) || "127.0.0.1"}:${num(port.hostPort)}:${num(port.containerPort)}/${str(port.proto) || str(port.protocol) || "tcp"}`;
    }),
    networks: [
      ...new Set(
        array(config.networks)
          .map((n) => str(obj(n).network))
          .filter(Boolean),
      ),
    ],
    volumes: [
      ...new Set(
        array(config.mounts)
          .map((mount) => str(obj(obj(obj(mount).type).volume).name))
          .filter(Boolean),
      ),
    ],
  };
}

function reclaimIdentity(value: unknown) {
  const config = obj(obj(value).configuration);
  return JSON.stringify({
    createdAt: str(config.creationDate),
    image: obj(config.image),
    labels: Object.entries(obj(config.labels)).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  });
}
export function commandArgs(
  command: ContainerCommand,
  owner?: ContainerOwner,
): string[] {
  switch (command.op) {
    case "run":
      return runArgs(
        command,
        owner ? ownershipArgs(owner, command.cleanup ?? "task") : [],
      );
    case "exec":
      return [
        "exec",
        ...(command.workdir ? ["--workdir", command.workdir] : []),
        command.id,
        ...command.command,
      ];
    case "pull":
      return ["image", "pull", "--progress", "plain", command.image];
    case "build":
      return [
        "build",
        "--progress",
        "plain",
        "--tag",
        command.tag,
        ...(command.file ? ["--file", command.file] : []),
        command.context,
      ];
    case "logs":
      return ["logs", "-n", String(command.lines), command.id];
    case "stats":
      return ["stats", "--no-stream", "--format", "json", command.id];
    case "reclaim":
      switch (command.target) {
        case "stopped-containers":
          return ["prune"];
        case "dangling-images":
          return ["image", "prune"];
        case "unused-images":
          return ["image", "prune", "--all"];
        case "unattached-volumes":
          return ["volume", "prune"];
      }
    case "system-start":
      return ["system", "start", "--disable-kernel-install"];
    default:
      return [command.op, command.id];
  }
}
export async function resolveBinary(configured: string): Promise<string> {
  const candidates = configured
    ? [configured]
    : [
        "/opt/homebrew/bin/container",
        "/usr/local/bin/container",
        ...(process.env.PATH ?? "")
          .split(":")
          .filter(isAbsolute)
          .map((p) => `${p}/container`),
      ];
  for (const path of [...new Set(candidates)]) {
    if (!isAbsolute(path))
      throw new Error("Container binary path must be absolute.");
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Try the next known installation. */
    }
  }
  throw new Error(
    "Apple container CLI was not found. Install it from github.com/apple/container, then refresh. Set binaryPath for a custom installation.",
  );
}
export async function checkMounts(command: ContainerCommand): Promise<void> {
  if (command.op === "run") {
    for (const mount of command.mounts) {
      // Resolve before launch so a misspelt path does not create a host directory.
      mount.source = await realpath(mount.source);
      if (/[,:\r\n]/.test(mount.source))
        throw new Error("Resolved mount path contains unsupported delimiters.");
      await stat(mount.source);
    }
  }
  if (command.op === "build" && !(await stat(command.context)).isDirectory())
    throw new Error(
      "Build context must be an existing directory on the selected Mac.",
    );
}
export async function perform(
  command: ContainerCommand,
  config: RuntimeConfig,
  runner: Runner,
  signal?: AbortSignal,
  owner?: ContainerOwner,
): Promise<CommandResult> {
  if (command.op === "reclaim") {
    if (command.target === "stopped-containers") {
      const values = parseArray(
        await runner(["list", "--all", "--format", "json"], 30_000, signal),
      );
      const stoppedManaged = values
        .map((value) => ({ ...summariseContainer(value), value }))
        .filter(
          (container) =>
            container.managed && container.state.toLowerCase() === "stopped",
        );
      for (const container of stoppedManaged) containerId.parse(container.id);
      const removed: string[] = [];
      for (const container of stoppedManaged) {
        signal?.throwIfAborted();
        try {
          await withContainerLock(container.id, async () => {
            signal?.throwIfAborted();
            const inspected = parseArray(
              await runner(["inspect", container.id], 30_000, signal),
            );
            const current =
              inspected.length === 1
                ? summariseContainer(inspected[0])
                : undefined;
            const labels = obj(obj(obj(container.value).configuration).labels);
            if (
              !current ||
              current.id !== container.id ||
              !current.managed ||
              current.state.toLowerCase() !== "stopped" ||
              (!container.createdAt && !str(labels[INSTANCE_LABEL])) ||
              reclaimIdentity(inspected[0]) !== reclaimIdentity(container.value)
            )
              throw new Error(
                `Container ${container.id} changed or is no longer stopped; left untouched. Refresh before retrying.`,
              );
            const result = await runner(
              ["delete", container.id],
              60_000,
              signal,
            );
            if (!result.ok || result.truncated)
              throw new Error(
                result.stderr ||
                  result.stdout ||
                  "Container CLI output was clipped.",
              );
            removed.push(container.id);
          });
        } catch (cause) {
          throw new Error(
            `Removed ${removed.length} of ${stoppedManaged.length} stopped BB-managed containers before cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: removed.length
          ? `Removed ${removed.length} stopped BB-managed ${removed.length === 1 ? "container" : "containers"}. Named volumes were kept.`
          : "No stopped BB-managed containers to reclaim.",
        stderr: "",
        truncated: false,
      };
    }
    if (!config.allowExternal)
      throw new Error(
        "Image and volume cleanup can affect resources created outside BB. Enable external container control in Apple Containers settings before reclaiming them.",
      );
  }
  const execute = async () => {
    if (
      ["start", "stop", "delete", "exec"].includes(command.op) &&
      "id" in command &&
      !config.allowExternal
    ) {
      const inspected = parseArray(
        await runner(["inspect", command.id], 30_000, signal),
      );
      if (inspected.length !== 1 || !summariseContainer(inspected[0]).managed) {
        throw new Error(
          "This container is not managed by BB. Enable allowExternal in plugin settings to control existing containers.",
        );
      }
    }
    return runner(commandArgs(command, owner), timeoutFor(command), signal);
  };
  const id =
    command.op === "run"
      ? command.name
      : ["start", "stop", "delete", "exec"].includes(command.op) &&
          "id" in command
        ? command.id
        : undefined;
  return id ? withContainerLock(id, execute) : execute();
}
export async function snapshot(
  config: RuntimeConfig,
  runner: Runner,
  signal?: AbortSignal,
  platform = process.platform,
  arch = process.arch,
  kernel = release(),
): Promise<Snapshot> {
  const supported =
    platform === "darwin" &&
    arch === "arm64" &&
    Number(kernel.split(".")[0]) >= 25;
  const result: Snapshot = {
    supported,
    installed: false,
    running: false,
    version: "",
    platform: `${platform} / ${arch}`,
    message: "",
    checkedAt: new Date().toISOString(),
    containers: [],
    images: [],
    networks: [],
    volumes: [],
    warnings: [],
    allowExternal: config.allowExternal,
  };
  if (!supported) {
    result.message =
      "Apple containers require Apple silicon and macOS 26 or later.";
    return result;
  }
  const version = await runner(["--version"], 10_000, signal);
  result.installed = version.ok;
  if (!version.ok) {
    result.message = version.stderr || "Apple container CLI is unavailable.";
    return result;
  }
  result.version = version.stdout.trim();
  const status = await runner(["system", "status"], 15_000, signal);
  result.running =
    status.ok && /(?:^|\n)status\s+running\b/.test(status.stdout);
  if (!result.running) {
    result.message =
      status.stderr ||
      status.stdout ||
      "Start the Apple container service to continue.";
    return result;
  }
  const reads = await Promise.allSettled([
    runner(["list", "--all", "--format", "json"], 30_000, signal).then(
      parseArray,
    ),
    runner(["image", "list", "--format", "json"], 30_000, signal).then(
      parseArray,
    ),
    runner(["network", "list", "--format", "json"], 30_000, signal).then(
      parseArray,
    ),
    runner(["volume", "list", "--format", "json"], 30_000, signal).then(
      parseArray,
    ),
  ]);
  for (const [i, read] of reads.entries()) {
    const label = ["Containers", "Images", "Networks", "Volumes"][i];
    if (read.status === "rejected") {
      result.warnings.push(
        `${label}: ${read.reason instanceof Error ? read.reason.message : String(read.reason)}`,
      );
      continue;
    }
    const values = (read.value as unknown[]).slice(0, 500);
    if ((read.value as unknown[]).length > 500)
      result.warnings.push(`${label}: showing the first 500 entries.`);
    if (i === 0) result.containers = values.map(summariseContainer);
    if (i === 1)
      result.images = values.map((v) => {
        const item = obj(v),
          configuration = obj(item.configuration),
          descriptor = obj(configuration.descriptor ?? item.descriptor);
        return {
          reference: str(configuration.name) || str(item.reference),
          digest: str(descriptor.digest),
          size:
            array(item.variants).reduce<number>(
              (total, variant) => total + num(obj(variant).size),
              0,
            ) || num(descriptor.size),
        };
      });
    if (i === 2)
      result.networks = values
        .map((v) => str(obj(v).id) || str(obj(v).name))
        .filter(Boolean);
    if (i === 3)
      result.volumes = values
        .map((v) => str(obj(v).name) || str(obj(v).id))
        .filter(Boolean);
  }
  result.message = "Apple container service is running.";
  return result;
}
export async function createRunner(config: RuntimeConfig): Promise<Runner> {
  const binary = await resolveBinary(config.binaryPath);
  return (args, timeout, signal) => runProcess(binary, args, timeout, signal);
}
export async function metrics(
  runner: Runner,
  signal?: AbortSignal,
): Promise<Metrics> {
  const values = parseArray(
    await runner(["stats", "--no-stream", "--format", "json"], 20_000, signal),
  );
  return {
    sampledAt: Date.now(),
    containers: values.slice(0, 500).map((value) => {
      const item = obj(value);
      return {
        id: str(item.id),
        cpuUsageUsec: num(item.cpuUsageUsec),
        memoryUsageBytes: num(item.memoryUsageBytes),
        memoryLimitBytes: num(item.memoryLimitBytes),
        networkRxBytes: num(item.networkRxBytes),
        networkTxBytes: num(item.networkTxBytes),
        blockReadBytes: num(item.blockReadBytes),
        blockWriteBytes: num(item.blockWriteBytes),
        numProcesses: num(item.numProcesses),
      };
    }),
  };
}
