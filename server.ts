import {
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  commandSchema,
  execSchema,
  hostContract,
  rpcContract,
  runSchema,
  type ContainerCommand,
  type CommandResult,
} from "./contract";
export { rpcContract } from "./contract";
import { timeoutFor } from "./lib/timeout";
import { createWorkspaceController } from "./lib/workspace-server";
import {
  workspaceActionSchema,
  workspaceExecSchema,
  workspaceProfileSchema,
  workspaceTeardownOptionsSchema,
} from "./lib/workspace-schema";
import {
  databasePreset,
  defaultWorkspaceProfile,
} from "./lib/workspace-presets";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    binaryPath: {
      type: "string",
      label: "Container binary path (empty = auto-detect on each Mac)",
      default: "",
      experimental_schema: z
        .string()
        .max(4096)
        .refine(
          (v) => !v || (v.startsWith("/") && !v.includes("\0")),
          "Use an absolute executable path",
        ),
    },
    defaultHostId: {
      type: "string",
      label: "Default machine ID for commands outside a thread",
      default: "",
    },
    allowExternal: {
      type: "boolean",
      label: "Allow control of containers created outside this plugin",
      default: false,
    },
    enableAgentTools: {
      type: "boolean",
      label: "Expose Apple container tools to agents",
      default: true,
    },
  });
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  async function resolveHost(
    explicit?: string,
    threadId?: string,
  ): Promise<string> {
    if (explicit) return explicit;
    if (threadId) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        return environment.hostId;
      }
      throw new Error(
        "This thread has no machine environment. Supply hostId explicitly.",
      );
    }
    const config = await settings.get();
    if (config.defaultHostId) return config.defaultHostId;
    const hosts = await bb.sdk.hosts.list();
    if (hosts.length === 1) return hosts[0]!.id;
    throw new Error(
      "Choose a machine with --host <id> (or hostId in tools). Run bb apple-containers hosts to see IDs.",
    );
  }
  async function getSnapshot(hostId: string, signal?: AbortSignal) {
    const { binaryPath, allowExternal } = await settings.get();
    return host.call(
      "snapshot",
      { binaryPath, allowExternal },
      { hostId, signal, timeoutMs: 60_000 },
    );
  }
  async function execute(hostId: string, input: unknown, signal?: AbortSignal) {
    const command = commandSchema.parse(input);
    const { binaryPath, allowExternal } = await settings.get();
    const result = await host.call(
      "perform",
      { config: { binaryPath, allowExternal }, command },
      { hostId, signal, timeoutMs: timeoutFor(command) + 35_000 },
    );
    if (!["logs", "inspect", "stats"].includes(command.op))
      bb.realtime.publish("changed", { hostId });
    return result;
  }
  const listHosts = async () => {
    const hosts = await bb.sdk.hosts.list();
    return { hosts: hosts.map((h) => ({ id: h.id, name: h.name })) };
  };
  const workspaces = await createWorkspaceController(
    bb,
    async (binding, action, signal) => {
      const { hostId, stopped: _stopped, ...workspace } = binding;
      const { binaryPath, allowExternal } = await settings.get();
      return host.call(
        "workspace",
        {
          config: { binaryPath, allowExternal },
          workspace: { ...workspace, action },
        },
        { hostId, signal, timeoutMs: 3_600_000 },
      );
    },
    async (binding, options, signal) => {
      const { hostId, stopped: _stopped, ...workspace } = binding;
      const { binaryPath, allowExternal } = await settings.get();
      return host.call(
        "workspaceTeardown",
        {
          config: { binaryPath, allowExternal },
          workspace,
          options,
        },
        { hostId, signal, timeoutMs: 900_000 },
      );
    },
    ({ projectId, environmentId, hostId }, signal) =>
      host.call(
        "workspaceTarget",
        { projectId, environmentId },
        { hostId, signal, timeoutMs: 30_000 },
      ),
  );
  bb.rpc.register(rpcContract, {
    ...workspaces.rpc,
    threadWorkspaceLogs: async ({ threadId, service }) => {
      const workspace = await workspaces.rpc.threadWorkspace({
        threadId,
        action: "status",
      });
      if (!workspace || workspace.inspection.kind !== "observed")
        throw new Error(
          "Wait for the workspace operation to finish, then try reading logs again.",
        );
      const container = workspace.inspection.state.services.find(
        (s) => s.name === service,
      );
      if (!container || container.state === "missing")
        throw new Error("This workspace service has no container yet.");
      return execute(workspace.hostId, {
        op: "logs",
        id: container.id,
        lines: 120,
      });
    },
    hosts: listHosts,
    snapshot: ({ hostId }) => getSnapshot(hostId),
    metrics: async ({ hostId }) => {
      const { binaryPath, allowExternal } = await settings.get();
      return host.call(
        "metrics",
        { binaryPath, allowExternal },
        { hostId, timeoutMs: 30_000 },
      );
    },
    perform: ({ hostId, command }) => execute(hostId, command),
  });

  const target = { hostId: z.string().min(1).optional() };
  const tools = [
    "apple_container_status",
    "apple_container_run",
    "apple_container_exec",
    "apple_container_read",
    "apple_container_manage",
    "apple_container_image",
    "apple_workspace",
    "apple_workspace_exec",
    "apple_workspace_setup",
    "apple_workspace_teardown",
  ];
  // Refresh session selection on settings changes; execution also enforces the toggle.
  bb.agents.configure((context) => ({
    tools: current.enableAgentTools ? tools : [],
    skills: ["apple-containers"],
    ...(current.enableAgentTools &&
    workspaces.profiles.get(context.project.id)?.enabled
      ? {
          instructions:
            "This project has a container environment for its app, database, and development tools. The agent and Git stay on the Mac. Before running app commands, builds, dependency installs, or tests, call apple_workspace with action ensure, then use apple_workspace_exec (default service app, cwd /workspace). Files in /workspace are the current checkout/worktree. Use the returned loopback ports for browser checks. Other worktrees have separate databases. Reuse this environment and preserve its volumes; do not recreate containers unless asked. Ensure reports containers running, not application or database readiness; check service logs/readiness before tests. When the task is finished and no more container work is needed, call apple_workspace_teardown to remove its containers and network, retaining named volumes. Respect user/repository instructions to keep a runtime or app running. Cleanup refuses while another thread is active in the same environment; report that deferral. Set removeVolumes=true only when deleting the persistent data is explicitly authorized.",
        }
      : {}),
  }));
  bb.agents.registerTool({
    name: "apple_workspace_teardown",
    description:
      "Clean up this thread's checkout/worktree after a finished task: stop and delete its owned containers and network. Named data volumes are kept by default. removeVolumes deletes their data too; dryRun previews resources. Refuses while another thread is active in the environment. Shared images and source files are kept.",
    instructions:
      "After completing container work, call apple_workspace_teardown unless user or repository instructions require keeping the runtime/app running. This is task completion, not an intermediate pause. Default cleanup preserves named data volumes. Use removeVolumes=true only with explicit authorization to delete persistent data. If in-use is returned, leave the shared stack running and report the active threads. Inspect status after a timeout before retrying.",
    parameters: workspaceTeardownOptionsSchema,
    async execute(options, ctx) {
      try {
        if (!(await settings.get()).enableAgentTools)
          throw new Error(
            "Apple container agent tools are disabled in plugin settings.",
          );
        const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
        if (!thread.environmentId)
          throw new Error("This thread has no workspace yet.");
        const result = await workspaces.teardown(
          thread.environmentId,
          options,
          ctx.threadId,
          ctx.signal,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(result.kind === "in-use" ? { isError: true } : {}),
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: errorText(error) }],
          isError: true,
        };
      }
    },
  });
  bb.agents.registerTool({
    name: "apple_workspace_setup",
    description:
      "Read this thread's project container setup and PostgreSQL/MySQL presets. Supply a complete profile to save the project's app, development tools and services. Saving does not start or replace existing containers. Credentials belong in workspace-local environment files, not the profile.",
    instructions:
      "When asked to configure a project's container environment, first call apple_workspace_setup with no arguments. Inspect the repository's tooling and existing container files. Adapt the returned default profile and database presets, keeping credentials in ignored local env files. Supply the full profile to save it, with enabled=true when requested. The project is always resolved from this thread. Then use apple_workspace ensure and apple_workspace_exec to start and verify when startup is requested. Existing instances retain their saved recipe; do not replace their containers unless the user asked to apply the change to them.",
    parameters: z
      .object({ profile: workspaceProfileSchema.optional() })
      .strict(),
    async execute({ profile }, ctx) {
      try {
        if (!(await settings.get()).enableAgentTools)
          throw new Error(
            "Apple container agent tools are disabled in plugin settings.",
          );
        const { projectId } = await bb.sdk.threads.get({
          threadId: ctx.threadId,
        });
        if (profile) {
          await workspaces.rpc.saveWorkspaceProfile({ projectId, profile });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  projectId,
                  saved: true,
                  enabled: profile.enabled,
                  autoStart: profile.autoStart,
                  services: [profile.app, ...profile.services].map(
                    ({ name, image }) => ({ name, image }),
                  ),
                  message:
                    "Project setup saved. Existing instances retain their recipe. Use apple_workspace ensure to start or reuse this thread's workspace when requested.",
                }),
              },
            ],
          };
        }
        const text = JSON.stringify({
          projectId,
          profile: workspaces.profiles.get(projectId) ?? null,
          defaultProfile: defaultWorkspaceProfile(),
          databasePresets: {
            postgres: databasePreset("postgres", ".env.containers.database"),
            mysql: databasePreset("mysql", ".env.containers.database"),
          },
        });
        if (text.length > 48_000)
          throw new Error(
            "This project profile is too large for a native tool response. Inspect it in Apple Containers → Projects before editing.",
          );
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: errorText(error) }],
          isError: true,
        };
      }
    },
  });
  bb.agents.registerTool({
    name: "apple_workspace",
    description:
      "Ensure, inspect or stop this thread's project containers. Reuses the current checkout/worktree's app, database, volumes and ports. Stop preserves data; ensure waits for any startup in progress.",
    parameters: z
      .object({
        action: workspaceActionSchema.exclude(["recreate"]).default("ensure"),
      })
      .strict(),
    async execute({ action }, ctx) {
      try {
        if (!(await settings.get()).enableAgentTools)
          throw new Error(
            "Apple container agent tools are disabled in plugin settings.",
          );
        const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
        if (!thread.environmentId)
          throw new Error("This thread has no workspace yet.");
        const state = await workspaces.action(
          thread.environmentId,
          action,
          ctx.signal,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(state) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: errorText(error) }],
          isError: true,
        };
      }
    },
  });
  bb.agents.registerTool({
    name: "apple_workspace_exec",
    description:
      "Run development commands inside this thread's project container, ensuring its workspace services first. Default service app, cwd /workspace. For a shell script pass ['sh','-lc','...']. Git stays on the Mac.",
    parameters: workspaceExecSchema,
    async execute(exec, ctx) {
      try {
        if (!(await settings.get()).enableAgentTools)
          throw new Error(
            "Apple container agent tools are disabled in plugin settings.",
          );
        const result = await workspaces.withThreadWorkspace(
          { threadId: ctx.threadId, service: exec.service, signal: ctx.signal },
          async ({ hostId, ...workspace }) => {
            const { binaryPath, allowExternal } = await settings.get();
            return host.call(
              "workspaceExec",
              { config: { binaryPath, allowExternal }, workspace, exec },
              { hostId, signal: ctx.signal, timeoutMs: 3_600_000 },
            );
          },
        );
        const output = JSON.stringify(result);
        return {
          content: [
            {
              type: "text" as const,
              text:
                output.length > 48_000
                  ? `${output.slice(0, 48_000)}\n[Output clipped at 48,000 characters.]`
                  : output,
            },
          ],
          isError: !result.ok,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: errorText(error) }],
          isError: true,
        };
      }
    },
  });
  async function toolCall(
    hostId: string | undefined,
    ctx: { threadId: string; signal: AbortSignal },
    command?: ContainerCommand,
  ) {
    try {
      if (!(await settings.get()).enableAgentTools)
        throw new Error(
          "Apple container agent tools are disabled in plugin settings.",
        );
      const id = await resolveHost(hostId, ctx.threadId);
      const result = command
        ? await execute(id, command, ctx.signal)
        : await getSnapshot(id, ctx.signal);
      const text = JSON.stringify({ hostId: id, ...result }, null, 2);
      return {
        content: [
          {
            type: "text" as const,
            text:
              text.length > 48_000
                ? `${text.slice(0, 48_000)}\n[Output clipped at 48,000 characters; use the CLI for more.]`
                : text,
          },
        ],
        isError: "ok" in result && !result.ok,
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: errorText(error) }],
        isError: true,
      };
    }
  }
  bb.agents.registerTool({
    name: tools[0]!,
    description:
      "Check Apple container runtime health, containers, images, networks and volumes on the thread's Mac or an explicit hostId.",
    parameters: z.object(target).strict(),
    execute: ({ hostId }, ctx) => toolCall(hostId, ctx),
  });
  bb.agents.registerTool({
    name: tools[1]!,
    description:
      "Create a detached Linux container using Apple's container runtime. Ports bind to loopback. Mounts are explicit and read-only by default. Paths refer to the selected Mac. Supply a long-lived command for a development container.",
    instructions:
      "Use Apple container tools when the user asks to run work in Apple containers. Check status first. Commands and bind mounts operate on the thread's machine; hostId overrides it explicitly. Only containers labelled by this plugin are controllable by default. Do not stop/delete pre-existing containers without user intent. Timeout/cancellation stops the CLI; inspect state before retrying because guest work may continue.",
    parameters: runSchema.omit({ op: true }).extend(target),
    execute: ({ hostId, ...input }, ctx) =>
      toolCall(hostId, ctx, { op: "run", ...input }),
  });
  bb.agents.registerTool({
    name: tools[2]!,
    description:
      "Execute an argv command inside a running BB-managed Apple container. For a shell script explicitly pass ['sh','-lc','...']. No host shell is used.",
    parameters: execSchema.omit({ op: true }).extend(target),
    execute: ({ hostId, ...input }, ctx) =>
      toolCall(hostId, ctx, { op: "exec", ...input }),
  });
  bb.agents.registerTool({
    name: tools[3]!,
    description:
      "Read inspect JSON, bounded logs or a single stats snapshot from an Apple container, including containers created outside BB.",
    parameters: z
      .object({
        ...target,
        id: z.string(),
        view: z.enum(["inspect", "logs", "stats"]),
        lines: z.number().int().min(1).max(2000).default(200),
      })
      .strict(),
    execute: ({ hostId, id, view, lines }, ctx) =>
      toolCall(
        hostId,
        ctx,
        commandSchema.parse(
          view === "logs" ? { op: view, id, lines } : { op: view, id },
        ),
      ),
  });
  bb.agents.registerTool({
    name: tools[4]!,
    description:
      "Start or stop a BB-managed Apple container, delete a stopped BB-managed container, or start the Apple container service. Deletion never forces a running container to stop.",
    parameters: z
      .object({
        ...target,
        action: z.enum(["start", "stop", "delete", "system-start"]),
        id: z.string().optional(),
      })
      .strict(),
    execute: ({ hostId, id, action }, ctx) =>
      toolCall(
        hostId,
        ctx,
        commandSchema.parse(
          action === "system-start" ? { op: action } : { op: action, id },
        ),
      ),
  });
  bb.agents.registerTool({
    name: tools[5]!,
    description:
      "Pull an OCI image or build an image from a Dockerfile using Apple containers. Build paths must be absolute paths on the selected Mac. Builds and pulls may take up to ten minutes.",
    parameters: z
      .object({
        ...target,
        action: z.enum(["pull", "build"]),
        image: z.string(),
        context: z.string().optional(),
        file: z.string().optional(),
      })
      .strict(),
    execute: ({ hostId, action, image, context, file }, ctx) =>
      toolCall(
        hostId,
        ctx,
        commandSchema.parse(
          action === "pull"
            ? { op: action, image }
            : { op: action, tag: image, context, ...(file ? { file } : {}) },
        ),
      ),
  });

  const common = {
    host: {
      type: "string" as const,
      description: "BB machine ID; defaults to the invoking thread's machine",
    },
    json: { type: "boolean" as const, description: "Emit JSON" },
  };
  const idPosition = [
    { name: "id", description: "Container ID", required: true },
  ] as const;
  const reply = (result: CommandResult, json: boolean) => ({
    exitCode: result.ok ? 0 : result.exitCode || 1,
    stdout: json
      ? JSON.stringify(result)
      : `${result.stdout}${result.truncated ? "\n[Output clipped at 256 KiB]" : ""}`,
    ...(!json && result.stderr ? { stderr: result.stderr } : {}),
  });
  const call = async (
    command: ContainerCommand,
    options: { host?: string; json: boolean },
    ctx: PluginCliContext,
  ) =>
    reply(
      await execute(
        await resolveHost(options.host, ctx.threadId),
        command,
        ctx.signal,
      ),
      options.json,
    );
  const namedCommand = (
    op: "start" | "stop" | "delete" | "inspect" | "stats",
  ) =>
    cliCommand({
      summary: `${op[0]!.toUpperCase()}${op.slice(1)} one container`,
      options: common,
      positionals: idPosition,
      run: (input, ctx) =>
        call({ op, id: input.positionals.id }, input.options, ctx),
    });
  const workspaceCommand = (
    action: "ensure" | "status" | "stop" | "recreate",
  ) =>
    cliCommand({
      summary: `${action} the checkout/worktree's project containers (data volumes are retained)`,
      options: {
        environment: {
          type: "string",
          description: "BB environment ID; defaults to this thread's workspace",
        },
        json: common.json,
      },
      async run(input, ctx) {
        const environmentId =
          input.options.environment ??
          (ctx.threadId
            ? (await bb.sdk.threads.get({ threadId: ctx.threadId }))
                .environmentId
            : null);
        if (!environmentId)
          throw new Error(
            "Supply --environment <id> or run inside a BB thread.",
          );
        const state = await workspaces.action(
          environmentId,
          action,
          ctx.signal,
        );
        return {
          exitCode: 0,
          stdout: input.options.json
            ? JSON.stringify(state)
            : state.services
                .map(
                  (v) =>
                    `${v.name}\t${v.state}\t${v.id}\t${v.ports.map((p) => `127.0.0.1:${p.host} → ${p.guest}`).join(", ")}`,
                )
                .join("\n") ||
              "No project containers have been created for this workspace.",
        };
      },
    });
  bb.cli.register(
    defineCli({
      name: "apple-containers",
      summary: "Apple container dashboard and agent controls",
      commands: {
        "workspace teardown": cliCommand({
          summary:
            "Remove this worktree's containers and network; keep named volumes unless --remove-volumes is explicit",
          options: {
            environment: {
              type: "string",
              description:
                "BB environment ID; defaults to this thread's workspace",
            },
            "remove-volumes": {
              type: "boolean",
              description:
                "Permanently delete this environment's named volumes and data",
              default: false,
            },
            "dry-run": {
              type: "boolean",
              description: "Preview cleanup without changing resources",
              default: false,
            },
            json: common.json,
          },
          async run(input, ctx) {
            const environmentId =
              input.options.environment ??
              (ctx.threadId
                ? (await bb.sdk.threads.get({ threadId: ctx.threadId }))
                    .environmentId
                : null);
            if (!environmentId)
              throw new Error(
                "Supply --environment <id> or run inside a BB thread.",
              );
            const result = await workspaces.teardown(
              environmentId,
              {
                removeVolumes: input.options["remove-volumes"],
                dryRun: input.options["dry-run"],
              },
              ctx.threadId,
              ctx.signal,
            );
            const message =
              result.kind === "in-use"
                ? `Cleanup deferred: environment is used by ${result.threads.map((t) => t.threadId).join(", ")}.`
                : result.kind === "absent"
                  ? "No workspace resources to remove."
                  : `${result.kind === "preview" ? "Would remove" : "Removed"} ${result.containers.length} containers, ${result.networks.length} networks and ${result.volumes.length} volumes. Retained ${result.retainedVolumes.length} named volumes. Shared images and source files are kept.`;
            return {
              exitCode: result.kind === "in-use" ? 1 : 0,
              stdout: input.options.json ? JSON.stringify(result) : message,
            };
          },
        }),
        "workspace up": workspaceCommand("ensure"),
        "workspace status": workspaceCommand("status"),
        "workspace stop": workspaceCommand("stop"),
        "workspace recreate": workspaceCommand("recreate"),
        hosts: cliCommand({
          summary: "List BB machine IDs",
          options: { json: common.json },
          async run(input) {
            const value = await listHosts();
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(value)
                : value.hosts.map((h) => `${h.id}  ${h.name}`).join("\n"),
            };
          },
        }),
        status: cliCommand({
          summary: "Runtime health and complete dashboard snapshot",
          options: common,
          async run(input, ctx) {
            const value = await getSnapshot(
              await resolveHost(input.options.host, ctx.threadId),
              ctx.signal,
            );
            return {
              exitCode: value.running ? 0 : 1,
              stdout: input.options.json
                ? JSON.stringify(value)
                : [
                    value.version,
                    value.platform,
                    value.message,
                    `${value.containers.length} containers; ${value.images.length} images`,
                    ...value.warnings,
                  ]
                    .filter(Boolean)
                    .join("\n"),
            };
          },
        }),
        list: cliCommand({
          summary: "List running and stopped containers",
          options: common,
          async run(input, ctx) {
            const value = await getSnapshot(
              await resolveHost(input.options.host, ctx.threadId),
              ctx.signal,
            );
            const failed =
              !value.running ||
              value.warnings.some((w) => w.startsWith("Containers:"));
            return {
              exitCode: failed ? 1 : 0,
              stdout: input.options.json
                ? JSON.stringify({
                    containers: value.containers,
                    warnings: value.warnings,
                  })
                : value.containers
                    .map(
                      (c) =>
                        `${c.id}\t${c.state}\t${c.image}\t${c.managed ? "BB" : "external"}`,
                    )
                    .join("\n") || value.message,
              ...(failed
                ? { stderr: [value.message, ...value.warnings].join("\n") }
                : {}),
            };
          },
        }),
        run: cliCommand({
          summary: "Create a detached BB-managed container",
          options: {
            ...common,
            name: {
              type: "string",
              required: true,
              description: "Unique container name",
            },
            cpus: {
              type: "integer",
              min: 1,
              max: 32,
              default: 2,
              description: "Virtual CPUs",
            },
            memory: {
              type: "integer",
              min: 200,
              max: 65536,
              default: 1024,
              description: "Memory in MiB",
            },
            env: {
              type: "string",
              repeatable: true,
              description: "KEY=value (repeatable)",
            },
            port: {
              type: "string",
              repeatable: true,
              description: "host:guest port on loopback (repeatable)",
            },
            mount: {
              type: "string",
              repeatable: true,
              description:
                "absolute-source:absolute-target[:ro|rw] (repeatable, defaults ro)",
            },
            workdir: {
              type: "string",
              description: "Absolute working directory in the guest",
            },
          },
          positionals: [
            {
              name: "image",
              required: true,
              description: "OCI image reference",
            },
            {
              name: "command",
              variadic: true,
              description: "Guest argv after --",
            },
          ],
          run(input, ctx) {
            const ports = input.options.port.map((v) => {
              const parts = v.split(":");
              if (parts.length !== 2) throw new Error("Use --port host:guest");
              return { host: Number(parts[0]), guest: Number(parts[1]) };
            });
            const mounts = input.options.mount.map((v) => {
              const [source, target, mode, extra] = v.split(":");
              if (
                !source ||
                !target ||
                extra !== undefined ||
                (mode !== undefined && mode !== "ro" && mode !== "rw")
              )
                throw new Error("Use --mount /source:/target[:ro|rw]");
              return { source, target, readOnly: mode !== "rw" };
            });
            return call(
              runSchema.parse({
                op: "run",
                name: input.options.name,
                image: input.positionals.image,
                command: input.positionals.command,
                cpus: input.options.cpus,
                memoryMiB: input.options.memory,
                env: input.options.env,
                ports,
                mounts,
                ...(input.options.workdir
                  ? { workdir: input.options.workdir }
                  : {}),
              }),
              input.options,
              ctx,
            );
          },
        }),
        exec: cliCommand({
          summary: "Run argv inside a managed container",
          options: {
            ...common,
            workdir: { type: "string", description: "Guest working directory" },
            timeout: {
              type: "integer",
              min: 1,
              max: 600,
              default: 60,
              description: "Timeout in seconds; guest processes may outlive it",
            },
          },
          positionals: [
            ...idPosition,
            {
              name: "command",
              variadic: true,
              required: true,
              description: "Guest argv after --",
            },
          ],
          run: (input, ctx) =>
            call(
              execSchema.parse({
                op: "exec",
                id: input.positionals.id,
                command: input.positionals.command,
                ...(input.options.workdir
                  ? { workdir: input.options.workdir }
                  : {}),
                timeoutSeconds: input.options.timeout,
              }),
              input.options,
              ctx,
            ),
        }),
        logs: cliCommand({
          summary: "Read bounded container logs",
          options: {
            ...common,
            lines: {
              type: "integer",
              min: 1,
              max: 2000,
              default: 200,
              description: "Tail line count",
            },
          },
          positionals: idPosition,
          run: (input, ctx) =>
            call(
              {
                op: "logs",
                id: input.positionals.id,
                lines: input.options.lines,
              },
              input.options,
              ctx,
            ),
        }),
        inspect: namedCommand("inspect"),
        stats: namedCommand("stats"),
        start: namedCommand("start"),
        stop: namedCommand("stop"),
        delete: namedCommand("delete"),
        pull: cliCommand({
          summary: "Pull an OCI image",
          options: common,
          positionals: [
            {
              name: "image",
              required: true,
              description: "OCI image reference",
            },
          ],
          run: (input, ctx) =>
            call(
              { op: "pull", image: input.positionals.image },
              input.options,
              ctx,
            ),
        }),
        build: cliCommand({
          summary: "Build an image on the selected Mac",
          options: {
            ...common,
            tag: { type: "string", required: true, description: "Image tag" },
            file: {
              type: "string",
              description: "Absolute Dockerfile path on the selected Mac",
            },
          },
          positionals: [
            {
              name: "context",
              required: true,
              description: "Absolute build directory on the selected Mac",
            },
          ],
          run: (input, ctx) =>
            call(
              commandSchema.parse({
                op: "build",
                context: input.positionals.context,
                tag: input.options.tag,
                ...(input.options.file ? { file: input.options.file } : {}),
              }),
              input.options,
              ctx,
            ),
        }),
        "system start": cliCommand({
          summary:
            "Start the service without automatically installing a kernel",
          options: common,
          run: (input, ctx) => call({ op: "system-start" }, input.options, ctx),
        }),
      },
    }),
  );
}
