import { z } from "zod";

const name = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/);
const argument = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !v.includes("\0"));
const path = argument.refine((v) => v.startsWith("/") && !/[,:\r\n]/.test(v));
const envFile = z
  .string()
  .max(512)
  .refine(
    (v) =>
      !v.startsWith("/") && !v.split("/").includes("..") && !/[\0\r\n]/.test(v),
    "Use an environment file relative to the workspace, without ..",
  );
export const workspaceServiceSchema = z
  .object({
    name,
    image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,511}$/),
    command: z.array(argument).max(128).default([]),
    ready: z.array(argument).max(128).default([]),
    readyTimeoutSeconds: z.number().int().min(1).max(300).default(90),
    envFile: envFile.default(""),
    mountWorkspace: z.boolean().optional(),
    ports: z.array(z.number().int().min(1).max(65535)).max(8).default([]),
    cpus: z.number().int().min(1).max(32).default(2),
    memoryMiB: z.number().int().min(200).max(65536).default(1024),
    volumes: z
      .array(z.object({ name, target: path }).strict())
      .max(8)
      .default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.ports).size !== v.ports.length)
      ctx.addIssue({ code: "custom", message: "Service ports must be unique" });
    if (
      new Set(v.volumes.map((x) => x.name)).size !== v.volumes.length ||
      new Set(v.volumes.map((x) => x.target)).size !== v.volumes.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Volume names and targets must be unique within a service",
      });
    if (v.volumes.some((x) => x.target === "/" || x.target === "/workspace"))
      ctx.addIssue({
        code: "custom",
        message: "Volumes cannot cover / or /workspace",
      });
  });
export const workspaceProfileSchema = z
  .object({
    enabled: z.boolean().default(false),
    autoStart: z.boolean().default(true),
    app: workspaceServiceSchema.refine(
      (v) => v.name === "app",
      "The development service must be named app",
    ),
    services: z.array(workspaceServiceSchema).max(4).default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    const names = [v.app.name, ...v.services.map((s) => s.name)];
    if (new Set(names).size !== names.length)
      ctx.addIssue({
        code: "custom",
        message: "Service names must be unique, including app",
      });
  });
// Keep older profiles readable for inspection and cleanup; reject ambiguous
// resource names when saving a setup or starting its containers.
export const workspaceSetupProfileSchema = workspaceProfileSchema.superRefine(
  (profile, ctx) => {
    const volumes = new Set<string>();
    for (const service of [profile.app, ...profile.services])
      for (const volume of service.volumes) {
        const resource = `${service.name}-${volume.name}`;
        if (volumes.has(resource))
          ctx.addIssue({
            code: "custom",
            message: `Volume resource ${resource} is shared by multiple definitions; choose distinct service or volume names`,
          });
        volumes.add(resource);
      }
  },
);
export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>;
export type WorkspaceService = z.infer<typeof workspaceServiceSchema>;
export const workspaceTargetSchema = z
  .object({
    projectId: z.string().min(1).max(256),
    environmentId: z.string().min(1).max(256),
    path,
    profile: workspaceProfileSchema,
  })
  .strict();
export type WorkspaceTarget = z.infer<typeof workspaceTargetSchema>;
export const workspaceIdentitySchema = workspaceTargetSchema.pick({
  projectId: true,
  environmentId: true,
});
export const workspaceActionSchema = z.enum([
  "ensure",
  "status",
  "stop",
  "recreate",
]);
export const workspaceStateSchema = z
  .object({
    environmentId: z.string(),
    path: z.string(),
    configured: z.boolean(),
    services: z.array(
      z
        .object({
          name: z.string(),
          id: z.string(),
          state: z.string(),
          address: z.string(),
          ports: z.array(
            z.object({ guest: z.number(), host: z.number() }).strict(),
          ),
          volumes: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
export const workspaceTeardownOptionsSchema = z
  .object({
    removeVolumes: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  })
  .strict();
export type WorkspaceTeardownOptions = z.infer<
  typeof workspaceTeardownOptionsSchema
>;
export const workspaceTeardownResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["preview", "removed"]),
      environmentId: z.string(),
      containers: z.array(z.string()),
      networks: z.array(z.string()),
      volumes: z.array(z.string()),
      retainedVolumes: z.array(z.string()),
    })
    .strict(),
  z.object({ kind: z.literal("absent"), environmentId: z.string() }).strict(),
  z
    .object({
      kind: z.literal("in-use"),
      environmentId: z.string(),
      threads: z.array(
        z
          .object({ threadId: z.string(), title: z.string().nullable() })
          .strict(),
      ),
    })
    .strict(),
]);
export type WorkspaceTeardownResult = z.infer<
  typeof workspaceTeardownResultSchema
>;
export const threadWorkspaceSchema = z.object({
  projectId: z.string(),
  environmentId: z.string(),
  hostId: z.string(),
  path: z.string(),
  name: z.string(),
  branchName: z.string(),
  isWorktree: z.boolean(),
  enabled: z.boolean(),
  services: z.array(z.object({ name: z.string(), image: z.string() })),
  lastError: z.string().nullable(),
  inspection: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("observed"), state: workspaceStateSchema }),
    z.object({
      kind: z.literal("checking"),
      state: workspaceStateSchema.nullable(),
    }),
    z.object({
      kind: z.literal("busy"),
      operation: z.enum(["ensure", "stop", "recreate", "teardown"]),
      state: workspaceStateSchema.nullable(),
    }),
    z.object({ kind: z.literal("unavailable"), message: z.string() }),
  ]),
});
export type ThreadWorkspace = z.infer<typeof threadWorkspaceSchema>;
export const workspaceHostInputSchema = workspaceTargetSchema.extend({
  action: workspaceActionSchema,
});
export const workspaceExecSchema = z
  .object({
    service: name.default("app"),
    command: z.array(argument).min(1).max(128),
    timeoutSeconds: z.number().int().min(1).max(600).default(60),
  })
  .strict();
