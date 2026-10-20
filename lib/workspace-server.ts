import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  workspaceProfileSchema,
  workspaceSetupProfileSchema,
  workspaceTargetSchema,
  type WorkspaceProfile,
  type WorkspaceTarget,
  type WorkspaceState,
  type ThreadWorkspace,
  type WorkspaceTeardownOptions,
  type WorkspaceTeardownResult,
} from "./workspace-schema";

const bindingSchema = workspaceTargetSchema.extend({
  hostId: z.string().min(1),
  stopped: z.boolean().default(false),
});
type Binding = z.infer<typeof bindingSchema>;
type Action = "ensure" | "status" | "stop" | "recreate";
export async function createWorkspaceController(
  bb: BbPluginApi,
  invoke: (
    binding: Binding,
    action: Action,
    signal?: AbortSignal,
  ) => Promise<WorkspaceState>,
  invokeTeardown: (
    binding: Binding,
    options: WorkspaceTeardownOptions,
    signal?: AbortSignal,
  ) => Promise<WorkspaceTeardownResult>,
  readTarget: (
    binding: Binding,
    signal?: AbortSignal,
  ) => Promise<WorkspaceTarget | null>,
) {
  const profiles = new Map<string, WorkspaceProfile>();
  const operations = new Map<string, Promise<unknown>>();
  const activeOperations = new Map<
    string,
    Exclude<Action, "status"> | "teardown"
  >();
  const lastStates = new Map<string, WorkspaceState>();
  const lastErrors = new Map<string, string>();
  const statusReads = new Map<string, Promise<WorkspaceState>>();
  async function serialize<T>(environmentId: string, run: () => Promise<T>) {
    const previous = operations.get(environmentId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(run);
    operations.set(environmentId, pending);
    try {
      return await pending;
    } finally {
      if (operations.get(environmentId) === pending)
        operations.delete(environmentId);
    }
  }
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  for (const key of await bb.storage.kv.list("profile:")) {
    const value = workspaceProfileSchema.parse(await bb.storage.kv.get(key));
    profiles.set(key.slice("profile:".length), value);
  }
  async function bindingFor(
    environmentId: string,
    action: Action,
  ): Promise<Binding> {
    const environment = await bb.sdk.environments.get({ environmentId });
    const stored = await bb.storage.kv.get(`workspace:${environmentId}`);
    const saved = stored ? bindingSchema.parse(stored) : null;
    if ((action === "stop" || action === "status") && saved) return saved;
    if (
      environment.status !== "ready" ||
      !environment.path ||
      environment.lifecycle.phase !== "active"
    )
      throw new Error(
        "Choose a ready checkout or worktree before starting project containers.",
      );
    const profile = profiles.get(environment.projectId);
    if (!profile?.enabled)
      throw new Error("Enable a container setup for this project first.");
    const binding = bindingSchema.parse({
      projectId: environment.projectId,
      environmentId,
      hostId: environment.hostId,
      path: environment.path,
      profile: action === "recreate" ? profile : (saved?.profile ?? profile),
    });
    if (
      saved &&
      (saved.hostId !== binding.hostId ||
        (saved.path !== binding.path && action !== "recreate") ||
        saved.projectId !== binding.projectId)
    )
      throw new Error(
        "The recorded workspace changed machine or directory; inspect its containers first.",
      );
    if (action === "ensure" || (action === "recreate" && !saved))
      await bb.storage.kv.set(`workspace:${environmentId}`, binding);
    else if (action === "recreate" && saved?.stopped)
      await bb.storage.kv.set(`workspace:${environmentId}`, {
        ...saved,
        stopped: false,
      });
    return binding;
  }
  async function currentHostBinding(binding: Binding, signal?: AbortSignal) {
    const target = await readTarget(binding, signal ?? lifetime.signal);
    return target ? { ...binding, ...target } : binding;
  }
  async function operate(
    environmentId: string,
    action: Action,
    signal?: AbortSignal,
  ) {
    if (
      action === "status" &&
      !(await bb.storage.kv.get(`workspace:${environmentId}`))
    ) {
      const environment = await bb.sdk.environments.get({ environmentId });
      return {
        environmentId,
        path: environment.path ?? "",
        configured: false,
        services: [],
      };
    }
    let binding = await bindingFor(environmentId, action);
    if (action === "stop") binding = await currentHostBinding(binding, signal);
    let state: WorkspaceState;
    try {
      state = await invoke(binding, action, signal ?? lifetime.signal);
    } catch (cause) {
      if (action === "recreate") {
        try {
          const target = await readTarget(binding, lifetime.signal);
          if (target) {
            await bb.storage.kv.set(`workspace:${environmentId}`, {
              ...binding,
              ...target,
              stopped: false,
            });
          }
        } catch {
          bb.log.warn(
            `Could not inspect the saved recipe after replacement failed for ${environmentId}; inspect the host before retrying.`,
          );
        }
      }
      throw cause;
    }
    if (action === "stop" || action === "recreate")
      await bb.storage.kv.set(`workspace:${environmentId}`, {
        ...binding,
        stopped: action === "stop",
      });
    return state;
  }
  async function runAction(
    environmentId: string,
    operation: Action,
    signal?: AbortSignal,
  ) {
    if (operation !== "status") {
      activeOperations.set(environmentId, operation);
      lastErrors.delete(environmentId);
      bb.realtime.publish("workspaces-changed", { environmentId });
    }
    try {
      const state = await operate(environmentId, operation, signal);
      lastStates.set(environmentId, state);
      return state;
    } catch (cause) {
      if (operation !== "status")
        lastErrors.set(
          environmentId,
          cause instanceof Error ? cause.message : String(cause),
        );
      throw cause;
    } finally {
      if (operation !== "status") {
        activeOperations.delete(environmentId);
        bb.realtime.publish("workspaces-changed", { environmentId });
      }
    }
  }
  const action = (
    environmentId: string,
    operation: Action,
    signal?: AbortSignal,
  ) => {
    const run = () => runAction(environmentId, operation, signal);
    // Host-side inspection is read-only and already protects manifest access.
    // Keep it off the command queue so tests/builds cannot hide thread status.
    return operation === "status" ? run() : serialize(environmentId, run);
  };
  async function inspect(environmentId: string) {
    const existing = statusReads.get(environmentId);
    if (existing) return existing;
    const pending = action(environmentId, "status");
    statusReads.set(environmentId, pending);
    try {
      return await pending;
    } finally {
      if (statusReads.get(environmentId) === pending)
        statusReads.delete(environmentId);
    }
  }
  async function teardown(
    environmentId: string,
    options: WorkspaceTeardownOptions,
    callerThreadId?: string,
    signal = lifetime.signal,
  ): Promise<WorkspaceTeardownResult> {
    async function blockers() {
      const threads: { threadId: string; title: string | null }[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await bb.sdk.threads.list({
          environmentId,
          includeHidden: true,
          limit: 100,
          offset,
          signal,
        });
        for (const thread of page)
          if (
            thread.id !== callerThreadId &&
            thread.environmentId === environmentId &&
            !["idle", "error"].includes(thread.status)
          )
            threads.push({ threadId: thread.id, title: thread.title });
        if (page.length < 100) return threads;
      }
    }
    if (operations.has(environmentId))
      throw new Error(
        "A workspace command is still in progress. Finish it before teardown.",
      );
    const busy = await blockers();
    if (busy.length) return { kind: "in-use", environmentId, threads: busy };
    return serialize(environmentId, async () => {
      const busy = await blockers();
      if (busy.length) return { kind: "in-use", environmentId, threads: busy };
      const stored = await bb.storage.kv.get(`workspace:${environmentId}`);
      let binding: Binding;
      if (stored) binding = bindingSchema.parse(stored);
      else {
        const environment = await bb.sdk.environments.get({ environmentId });
        if (!profiles.get(environment.projectId)?.enabled)
          return { kind: "absent", environmentId };
        binding = await bindingFor(environmentId, "status");
      }
      if (!options.dryRun) {
        activeOperations.set(environmentId, "teardown");
        lastErrors.delete(environmentId);
        bb.realtime.publish("workspaces-changed", { environmentId });
      }
      try {
        binding = await currentHostBinding(binding, signal);
        const result = await invokeTeardown(binding, options, signal);
        if (
          !options.dryRun &&
          (result.kind === "removed" || result.kind === "absent")
        ) {
          await bb.storage.kv.set(`workspace:${environmentId}`, {
            ...binding,
            stopped: true,
          });
          lastStates.set(environmentId, {
            environmentId,
            path: binding.path,
            configured: false,
            services: [],
          });
        }
        return result;
      } catch (cause) {
        if (!options.dryRun)
          lastErrors.set(
            environmentId,
            cause instanceof Error ? cause.message : String(cause),
          );
        throw cause;
      } finally {
        if (!options.dryRun) {
          activeOperations.delete(environmentId);
          bb.realtime.publish("workspaces-changed", { environmentId });
          bb.realtime.publish("changed", { hostId: binding.hostId });
        }
      }
    });
  }
  async function threadWorkspace({
    threadId,
    action: operation,
    inspect: inspectRuntime = true,
  }: {
    threadId: string;
    action: "status" | "ensure" | "stop";
    inspect?: boolean;
  }): Promise<ThreadWorkspace | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) {
      if (operation !== "status")
        throw new Error("This thread has no checkout or worktree yet.");
      return null;
    }
    const environmentId = thread.environmentId;
    const stored = await bb.storage.kv.get(`workspace:${environmentId}`);
    const binding = stored ? bindingSchema.parse(stored) : null;
    const profile = profiles.get(thread.projectId);
    if (!profile?.enabled && !binding) {
      if (operation !== "status")
        throw new Error("Enable a container setup for this project first.");
      return null;
    }
    const environment = await bb.sdk.environments.get({ environmentId });
    const recipe = binding?.profile ?? profile;
    if (!recipe) return null;
    let inspection: ThreadWorkspace["inspection"];
    if (operation !== "status") {
      inspection = {
        kind: "observed",
        state: await action(environmentId, operation),
      };
    } else {
      const active = activeOperations.get(environmentId);
      if (active)
        inspection = {
          kind: "busy",
          operation: active,
          state: lastStates.get(environmentId) ?? null,
        };
      else if (!inspectRuntime)
        inspection = {
          kind: "checking",
          state: lastStates.get(environmentId) ?? null,
        };
      else {
        try {
          inspection = {
            kind: "observed",
            state: await inspect(environmentId),
          };
        } catch (cause) {
          inspection = {
            kind: "unavailable",
            message: cause instanceof Error ? cause.message : String(cause),
          };
        }
      }
    }
    return {
      projectId: thread.projectId,
      environmentId,
      hostId: binding?.hostId ?? environment.hostId,
      path: binding?.path ?? environment.path ?? "",
      name:
        environment.name ??
        environment.branchName ??
        (environment.isWorktree ? "Worktree" : "Project checkout"),
      branchName: environment.branchName ?? "",
      isWorktree: environment.isWorktree ?? false,
      enabled: profile?.enabled ?? false,
      services: [recipe.app, ...recipe.services].map(({ name, image }) => ({
        name,
        image,
      })),
      lastError: lastErrors.get(environmentId) ?? null,
      inspection,
    };
  }
  bb.events.on("thread.active", async ({ thread }) => {
    if (
      !thread.environmentId ||
      !profiles.get(thread.projectId)?.enabled ||
      !profiles.get(thread.projectId)?.autoStart
    )
      return;
    try {
      await action(thread.environmentId, "ensure");
    } catch {
      bb.log.warn(
        `Project container startup did not complete for ${thread.environmentId}; use the project environment controls or apple_workspace to inspect and retry.`,
      );
    }
  });
  async function retireUnlocked(environmentId: string) {
    const stored = await bb.storage.kv.get(`workspace:${environmentId}`);
    if (!stored) return;
    let binding = bindingSchema.parse(stored);
    if (binding.stopped) return;
    binding = await currentHostBinding(binding);
    await invoke(binding, "stop", lifetime.signal);
    await bb.storage.kv.set(`workspace:${environmentId}`, {
      ...binding,
      stopped: true,
    });
    bb.realtime.publish("workspaces-changed", { environmentId });
  }
  const retire = (environmentId: string) =>
    serialize(environmentId, () => retireUnlocked(environmentId));
  bb.events.on("experimental_environment.removed", async ({ removal }) => {
    try {
      await retire(removal.environmentId);
    } catch {
      bb.log.warn(
        `Project container cleanup pending for ${removal.environmentId}; database volumes are retained.`,
      );
    }
  });
  // Reconcile missed removal events after reload, and retry offline-machine cleanup.
  bb.background.schedule("retire-project-containers", "* * * * *", async () => {
    for (const key of await bb.storage.kv.list("workspace:")) {
      const binding = bindingSchema.parse(await bb.storage.kv.get(key));
      if (binding.stopped) continue;
      try {
        const environment = await bb.sdk.environments.get({
          environmentId: binding.environmentId,
        });
        if (environment.status === "destroyed")
          await retire(binding.environmentId);
      } catch {
        bb.log.warn(
          `Could not reconcile project containers for ${binding.environmentId}.`,
        );
      }
    }
  });
  return {
    profiles,
    action,
    teardown,
    async withThreadWorkspace<T>(
      {
        threadId,
        service,
        signal,
      }: {
        threadId: string;
        service: string;
        signal?: AbortSignal;
      },
      run: (target: WorkspaceTarget & { hostId: string }) => Promise<T>,
    ) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.environmentId)
        throw new Error("This thread has no checkout or worktree yet.");
      const environmentId = thread.environmentId;
      return serialize(environmentId, async () => {
        const binding = await bindingFor(environmentId, "status");
        if (
          ![binding.profile.app, ...binding.profile.services].some(
            (s) => s.name === service,
          )
        )
          throw new Error(`Unknown workspace service: ${service}`);
        await runAction(environmentId, "ensure", signal);
        const { stopped: _stopped, ...target } = await bindingFor(
          environmentId,
          "status",
        );
        return run(target);
      });
    },
    rpc: {
      threadWorkspace,
      async workspaceProjects() {
        const projects = await bb.sdk.projects.list();
        return projects
          .filter((p) => p.kind === "standard")
          .map((p) => ({
            id: p.id,
            name: p.name,
            profile: profiles.get(p.id) ?? null,
          }));
      },
      async saveWorkspaceProfile({
        projectId,
        profile,
      }: {
        projectId: string;
        profile: WorkspaceProfile;
      }) {
        profile = workspaceSetupProfileSchema.parse(profile);
        await bb.sdk.projects.get({ projectId });
        await bb.storage.kv.set(`profile:${projectId}`, profile);
        profiles.set(projectId, profile);
        bb.realtime.publish("workspaces-changed", { projectId });
        return profile;
      },
      async workspaceEnvironments({
        projectId,
        hostId,
      }: {
        projectId: string;
        hostId: string;
      }) {
        const environments = await bb.sdk.environments.list({
          projectId,
          hostId,
          status: "ready",
          limit: 500,
        });
        return environments.flatMap((e) =>
          e.path && e.lifecycle.phase === "active"
            ? [
                {
                  id: e.id,
                  path: e.path,
                  name: e.name ?? e.branchName ?? "Project checkout",
                  isWorktree: e.isWorktree,
                },
              ]
            : [],
        );
      },
      workspace({
        environmentId,
        action: operation,
      }: {
        environmentId: string;
        action: Action;
      }) {
        return action(environmentId, operation);
      },
    },
  };
}
