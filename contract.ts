import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Restrict option-bearing values before they reach the executable. Commands
// inside the guest remain argv arrays: no host shell is ever involved.
const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !v.includes("\0"), "NUL is not allowed");
export const containerId = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
export const imageReference = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,511}$/);
const guestPath = text.refine(
  (v) => v.startsWith("/"),
  "Use an absolute guest path",
);
const hostPath = guestPath.refine(
  (v) => !/[,:\r\n]/.test(v),
  "Path cannot contain commas, colons or newlines",
);
const argv = z.array(text).max(128);
export const runSchema = z
  .object({
    op: z.literal("run"),
    name: containerId,
    image: imageReference,
    command: argv.default([]),
    cpus: z.number().int().min(1).max(32).default(2),
    memoryMiB: z.number().int().min(128).max(65536).default(1024),
    workdir: guestPath.optional(),
    env: z
      .array(
        text.refine((v) => /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(v), "Use KEY=value"),
      )
      .max(64)
      .default([]),
    ports: z
      .array(
        z
          .object({
            host: z.number().int().min(1).max(65535),
            guest: z.number().int().min(1).max(65535),
          })
          .strict(),
      )
      .max(16)
      .default([]),
    mounts: z
      .array(
        z
          .object({
            source: hostPath,
            target: hostPath,
            readOnly: z.boolean().default(true),
          })
          .strict(),
      )
      .max(16)
      .default([]),
  })
  .strict();
export const execSchema = z
  .object({
    op: z.literal("exec"),
    id: containerId,
    command: argv.min(1),
    workdir: guestPath.optional(),
    timeoutSeconds: z.number().int().min(1).max(600).default(60),
  })
  .strict();
export const commandSchema = z.discriminatedUnion("op", [
  runSchema,
  execSchema,
  z.object({ op: z.literal("pull"), image: imageReference }).strict(),
  z
    .object({
      op: z.literal("build"),
      context: guestPath,
      tag: imageReference,
      file: guestPath.optional(),
    })
    .strict(),
  z.object({ op: z.literal("start"), id: containerId }).strict(),
  z.object({ op: z.literal("stop"), id: containerId }).strict(),
  z.object({ op: z.literal("delete"), id: containerId }).strict(),
  z.object({ op: z.literal("inspect"), id: containerId }).strict(),
  z
    .object({
      op: z.literal("logs"),
      id: containerId,
      lines: z.number().int().min(1).max(2000).default(200),
    })
    .strict(),
  z.object({ op: z.literal("stats"), id: containerId }).strict(),
  z.object({ op: z.literal("system-start") }).strict(),
]);
export type ContainerCommand = z.infer<typeof commandSchema>;
export type RunInput = z.infer<typeof runSchema>;
export const configSchema = z
  .object({ binaryPath: z.string().max(4096), allowExternal: z.boolean() })
  .strict();
export type RuntimeConfig = z.infer<typeof configSchema>;
export const resultSchema = z
  .object({
    ok: z.boolean(),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type CommandResult = z.infer<typeof resultSchema>;
export const containerSchema = z.object({
  id: z.string(),
  image: z.string(),
  state: z.string(),
  managed: z.boolean(),
  cpus: z.number(),
  memoryBytes: z.number(),
  addresses: z.array(z.string()),
  ports: z.array(z.string()),
  createdAt: z.string(),
});
export type ContainerSummary = z.infer<typeof containerSchema>;
export const snapshotSchema = z.object({
  supported: z.boolean(),
  installed: z.boolean(),
  running: z.boolean(),
  version: z.string(),
  platform: z.string(),
  message: z.string(),
  checkedAt: z.string(),
  containers: z.array(containerSchema),
  images: z.array(
    z.object({ reference: z.string(), digest: z.string(), size: z.number() }),
  ),
  networks: z.array(z.string()),
  volumes: z.array(z.string()),
  warnings: z.array(z.string()),
  allowExternal: z.boolean(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const metricsSchema = z.object({
  sampledAt: z.number(),
  containers: z.array(
    z.object({
      id: z.string(),
      cpuUsageUsec: z.number(),
      memoryUsageBytes: z.number(),
      memoryLimitBytes: z.number(),
      networkRxBytes: z.number(),
      networkTxBytes: z.number(),
      blockReadBytes: z.number(),
      blockWriteBytes: z.number(),
      numProcesses: z.number(),
    }),
  ),
});
export type Metrics = z.infer<typeof metricsSchema>;
export const hostContract = defineRpcContract({
  snapshot: { input: configSchema, output: snapshotSchema },
  metrics: { input: configSchema, output: metricsSchema },
  perform: {
    input: z.object({ config: configSchema, command: commandSchema }).strict(),
    output: resultSchema,
  },
});
export const rpcContract = defineRpcContract({
  hosts: {
    input: z.null(),
    output: z.object({
      hosts: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  snapshot: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: snapshotSchema,
  },
  metrics: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: metricsSchema,
  },
  perform: {
    input: z
      .object({ hostId: z.string().min(1), command: commandSchema })
      .strict(),
    output: resultSchema,
  },
});
