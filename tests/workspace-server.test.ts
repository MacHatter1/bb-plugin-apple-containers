import { afterEach, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import {
  workspaceProfileSchema,
  workspaceTargetSchema,
  type WorkspaceTarget,
} from "../lib/workspace-schema";
import { z } from "zod";
import {
  databasePreset,
  defaultWorkspaceProfile,
} from "../lib/workspace-presets";
import { success } from "./fixtures";
import { hostContract } from "../contract";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
const profile = workspaceProfileSchema.parse({
  enabled: true,
  app: { name: "app", image: "alpine:3.23", command: ["sleep", "infinity"] },
});
const toolResponseSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean().optional(),
});
async function setup(
  workspaceCall?: (input: unknown) => unknown | Promise<unknown>,
  execCall?: () => Promise<unknown>,
  teardownCall?: (input: unknown) => unknown | Promise<unknown>,
  targetCall?: () => WorkspaceTarget | null | Promise<WorkspaceTarget | null>,
) {
  let destroyed = false;
  const environmentPaths = new Map<string, string>();
  const targets = new Map<string, WorkspaceTarget>();
  let threads: ReturnType<typeof makeThreadResponse>[] = [];
  const fake = createFakePluginHost({
    pluginId: "apple-containers",
    agentSkillIds: ["apple-containers"],
    sdk: {
      hosts: { list: async () => [makeHostResponse({ id: "mac-a" })] },
      projects: {
        list: async () => [{ id: "project-a", kind: "standard", name: "Demo" }],
        get: async () => ({ id: "project-a" }),
      },
      threads: {
        list: async ({ offset = 0, limit = 100 } = {}) =>
          threads.slice(offset, offset + limit),
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "project-a",
            environmentId: threadId === "thread-b" ? "env-b" : "env-a",
          }),
      },
      environments: {
        get: async ({ environmentId }) => ({
          id: environmentId,
          projectId: "project-a",
          hostId: "mac-a",
          path: environmentPaths.get(environmentId) ?? `/work/${environmentId}`,
          status: destroyed ? "destroyed" : "ready",
          lifecycle: { phase: destroyed ? "destroyed" : "active" },
        }),
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "workspaceTarget") {
        if (targetCall) return targetCall();
        const { environmentId } = z
          .object({ environmentId: z.string() })
          .parse(input);
        return targets.get(environmentId) ?? null;
      }
      if (method === "workspaceTeardown") {
        if (teardownCall) return teardownCall(input);
        const { workspace, options } =
          hostContract.workspaceTeardown.input.parse(input);
        return {
          kind: options.dryRun ? "preview" : "removed",
          environmentId: workspace.environmentId,
          containers: ["owned-app"],
          networks: ["owned-network"],
          volumes: options.removeVolumes ? ["data"] : [],
          retainedVolumes: options.removeVolumes ? [] : ["data"],
        };
      }
      if (method === "workspaceExec")
        return execCall ? execCall() : success("Linux");
      if (method === "perform") return success("workspace logs");
      const { workspace } = hostContract.workspace.input.parse(input);
      const result = workspaceCall
        ? await workspaceCall(input)
        : {
            environmentId: workspace.environmentId,
            path: workspace.path,
            configured: true,
            services: [],
          };
      if (workspace.action === "ensure" || workspace.action === "recreate") {
        const { action: _action, ...target } = workspace;
        targets.set(
          workspace.environmentId,
          workspaceTargetSchema.parse(target),
        );
      }
      return result;
    },
  });
  await plugin(fake.bb);
  disposers.push(() => fake.harness.lifecycle.dispose());
  return {
    ...fake,
    setPath(environmentId: string, path: string) {
      environmentPaths.set(environmentId, path);
    },
    setThreads(next: typeof threads) {
      threads = next;
    },
    destroy() {
      destroyed = true;
    },
  };
}

it("keeps thread header reads quiet until a project is enabled and never provisions from status", async () => {
  const { harness: h } = await setup();
  expect(
    await h.behavior.callRpc("threadWorkspace", { threadId: "thread-a" }),
  ).toBeNull();
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  const events = h.realtimeSignals.length;
  expect(
    await h.behavior.callRpc("threadWorkspace", { threadId: "thread-a" }),
  ).toMatchObject({
    environmentId: "env-a",
    hostId: "mac-a",
    services: [{ name: "app", image: "alpine:3.23" }],
    inspection: { kind: "observed", state: { configured: false } },
  });
  expect(h.experimental_hostRpcCalls).toHaveLength(0);
  expect(h.realtimeSignals).toHaveLength(events);
});

it("returns configured header metadata before contacting the container host", async () => {
  const { harness: h } = await setup(() => {
    throw new Error("Host inspection must not run for metadata");
  });
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  expect(
    await h.behavior.callRpc("threadWorkspace", {
      threadId: "thread-a",
      inspect: false,
    }),
  ).toMatchObject({
    environmentId: "env-a",
    services: [{ name: "app", image: "alpine:3.23" }],
    inspection: { kind: "checking", state: null },
  });
  expect(h.experimental_hostRpcCalls).toHaveLength(0);
});
function runningWorkspace(input: unknown) {
  const { workspace } = hostContract.workspace.input.parse(input);
  return {
    environmentId: workspace.environmentId,
    path: workspace.path,
    configured: true,
    services: [
      {
        name: "app",
        id: `${workspace.environmentId}-app`,
        state: workspace.action === "stop" ? "stopped" : "running",
        address: "192.168.1.2",
        ports: [{ guest: 3000, host: 42000 }],
        volumes: ["app-deps"],
      },
    ],
  };
}
it("keeps a configured thread's badge readable while another thread runs a long container command", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { harness: h } = await setup(runningWorkspace, async () => {
    entered();
    await pending;
    return success("Finished");
  });
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  await h.behavior.callRpc("threadWorkspace", {
    threadId: "thread-a",
    action: "ensure",
  });
  const execution = h.behavior.callAgentTool(
    "apple_workspace_exec",
    { command: ["sleep", "60"] },
    { threadId: "same-worktree" },
  );
  await started;
  let visible = false;
  const status = h.behavior
    .callRpc("threadWorkspace", { threadId: "thread-a" })
    .then((value) => {
      expect(value).toMatchObject({
        lastError: null,
        inspection: {
          kind: "observed",
          state: { services: [{ state: "running" }] },
        },
      });
      visible = value !== null;
    });
  try {
    await vi.waitFor(() => expect(visible).toBe(true), {
      timeout: 150,
      interval: 5,
    });
  } finally {
    release();
    await Promise.all([execution, status]);
  }
});
it("reports startup to another thread without waiting for provisioning and preserves pinned images", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { harness: h } = await setup(async (input) => {
    if (
      hostContract.workspace.input.parse(input).workspace.action === "ensure"
    ) {
      entered();
      await pending;
    }
    return runningWorkspace(input);
  });
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  const startup = h.behavior.callRpc("threadWorkspace", {
    threadId: "thread-a",
    action: "ensure",
  });
  await started;
  expect(
    await h.behavior.callRpc("threadWorkspace", { threadId: "same-worktree" }),
  ).toMatchObject({
    environmentId: "env-a",
    inspection: { kind: "busy", operation: "ensure", state: null },
  });
  expect(h.experimental_hostRpcCalls).toHaveLength(1);
  release();
  await startup;
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile: {
      ...profile,
      enabled: false,
      app: { ...profile.app, image: "different:dev" },
    },
  });
  expect(
    await h.behavior.callRpc("threadWorkspace", { threadId: "same-worktree" }),
  ).toMatchObject({
    enabled: false,
    services: [{ name: "app", image: "alpine:3.23" }],
    inspection: {
      kind: "observed",
      state: { services: [{ state: "running" }] },
    },
  });
});
it("scopes header actions and logs to the thread's current worktree", async () => {
  const { harness: h } = await setup(runningWorkspace);
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  await h.behavior.callRpc("threadWorkspace", {
    threadId: "thread-b",
    action: "ensure",
  });
  await h.behavior.callRpc("threadWorkspaceLogs", {
    threadId: "thread-b",
    service: "app",
  });
  expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
    hostId: "mac-a",
    method: "perform",
    input: { command: { op: "logs", id: "env-b-app", lines: 120 } },
  });
  await expect(
    h.behavior.callRpc("threadWorkspaceLogs", {
      threadId: "thread-b",
      service: "unrelated",
    }),
  ).rejects.toThrow("no container yet");
  expect(
    await h.behavior.callRpc("threadWorkspace", {
      threadId: "thread-b",
      action: "stop",
    }),
  ).toMatchObject({
    environmentId: "env-b",
    inspection: {
      kind: "observed",
      state: { services: [{ state: "stopped" }] },
    },
  });
  await expect(
    h.behavior.callRpc("threadWorkspace", {
      threadId: "thread-b",
      environmentId: "env-a",
    }),
  ).rejects.toThrow();
});
it("reports an unavailable host and retains a failed startup without inventing runtime health", async () => {
  let offline = false;
  const { harness: h } = await setup((input) => {
    if (offline) throw new Error("Workspace Mac offline");
    return runningWorkspace(input);
  });
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  await h.behavior.callRpc("threadWorkspace", {
    threadId: "thread-a",
    action: "ensure",
  });
  offline = true;
  expect(
    await h.behavior.callRpc("threadWorkspace", { threadId: "thread-a" }),
  ).toMatchObject({
    inspection: { kind: "unavailable", message: "Workspace Mac offline" },
  });
  await expect(
    h.behavior.callRpc("threadWorkspace", {
      threadId: "thread-a",
      action: "ensure",
    }),
  ).rejects.toThrow("Workspace Mac offline");
  offline = false;
  expect(
    await h.behavior.callRpc("threadWorkspace", { threadId: "thread-a" }),
  ).toMatchObject({
    lastError: "Workspace Mac offline",
    inspection: { kind: "observed" },
  });
  await h.behavior.callRpc("threadWorkspace", {
    threadId: "thread-a",
    action: "ensure",
  });
  expect(
    await h.behavior.callRpc("threadWorkspace", { threadId: "thread-a" }),
  ).toMatchObject({ lastError: null });
});
it("returns a quiet unconfigured status without provisioning, then saves a reusable project recipe", async () => {
  const { harness: h } = await setup();
  expect(
    await h.behavior.callRpc("workspace", {
      environmentId: "env-a",
      action: "status",
    }),
  ).toMatchObject({ configured: false });
  expect(h.experimental_hostRpcCalls).toHaveLength(0);
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  expect(await h.behavior.callRpc("workspaceProjects", null)).toEqual([
    { id: "project-a", name: "Demo", profile },
  ]);
  await h.behavior.callAgentTool(
    "apple_workspace",
    {},
    { threadId: "thread-a" },
  );
  await h.behavior.callAgentTool(
    "apple_workspace",
    {},
    { threadId: "thread-b" },
  );
  expect(h.experimental_hostRpcCalls.map((c) => c.hostId)).toEqual([
    "mac-a",
    "mac-a",
  ]);
  const signals = h.realtimeSignals.length;
  await h.behavior.callRpc("workspace", {
    environmentId: "env-a",
    action: "status",
  });
  expect(h.realtimeSignals).toHaveLength(signals);
  expect(
    h.experimental_hostRpcCalls.map(
      (c) =>
        (c.input as { workspace: { environmentId: string } }).workspace
          .environmentId,
    ),
  ).toEqual(["env-a", "env-b", "env-a"]);
});
it("pins an existing recipe until explicitly replaced and injects instructions only into configured projects", async () => {
  const { harness: h } = await setup();
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  await h.behavior.callRpc("workspace", {
    environmentId: "env-a",
    action: "ensure",
  });
  const next = { ...profile, app: { ...profile.app, image: "another:dev" } };
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile: next,
  });
  await h.behavior.callRpc("workspace", {
    environmentId: "env-a",
    action: "ensure",
  });
  expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
    input: { workspace: { profile } },
  });
  await h.behavior.callRpc("workspace", {
    environmentId: "env-a",
    action: "recreate",
  });
  expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
    input: { workspace: { profile: next } },
  });
  const context = makePluginAgentConfigurationContext();
  context.project.id = "project-a";
  expect(
    (await h.behavior.resolveAgentConfiguration(context)).instructions,
  ).toContain("apple_workspace_exec");
  context.project.id = "unconfigured";
  const instructions = (await h.behavior.resolveAgentConfiguration(context))
    .instructions;
  expect(instructions).toContain("apple_container_cleanup");
  expect(instructions).not.toContain(
    "This project has a container environment",
  );
});
it.each([false, true])(
  "keeps the original pin after failed replacement (manifest read unavailable: %s)",
  async (unavailable) => {
    const { harness: h, bb } = await setup(
      async (input) => {
        const { workspace } = hostContract.workspace.input.parse(input);
        if (workspace.action === "recreate") throw new Error("Mac offline");
        return runningWorkspace(input);
      },
      undefined,
      undefined,
      unavailable
        ? () => {
            throw new Error("Host unreachable");
          }
        : undefined,
    );
    await h.behavior.callRpc("saveWorkspaceProfile", {
      projectId: "project-a",
      profile,
    });
    await h.behavior.callRpc("workspace", {
      environmentId: "env-a",
      action: "ensure",
    });
    const next = { ...profile, app: { ...profile.app, image: "node:24" } };
    await h.behavior.callRpc("saveWorkspaceProfile", {
      projectId: "project-a",
      profile: next,
    });
    await expect(
      h.behavior.callRpc("workspace", {
        environmentId: "env-a",
        action: "recreate",
      }),
    ).rejects.toThrow("Mac offline");
    expect(await bb.storage.kv.get("workspace:env-a")).toMatchObject({
      profile,
    });
    expect(
      await h.behavior.callRpc("threadWorkspace", {
        threadId: "thread-a",
        inspect: false,
      }),
    ).toMatchObject({ services: [{ image: profile.app.image }] });
    await h.behavior.callRpc("workspace", {
      environmentId: "env-a",
      action: "ensure",
    });
    expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
      input: { workspace: { profile } },
    });
  },
);

it("rejects colliding setup volumes and unknown exec services before provisioning", async () => {
  const { harness: h } = await setup();
  await expect(
    h.behavior.callRpc("saveWorkspaceProfile", {
      projectId: "project-a",
      profile: {
        ...profile,
        services: [
          {
            name: "db",
            image: "alpine:3.23",
            volumes: [{ name: "backup-data", target: "/data" }],
          },
          {
            name: "db-backup",
            image: "alpine:3.23",
            volumes: [{ name: "data", target: "/data" }],
          },
        ],
      },
    }),
  ).rejects.toThrow(/volume resource/i);
  expect(await h.behavior.callRpc("workspaceProjects", null)).toMatchObject([
    { profile: null },
  ]);
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  const result = await h.behavior.callAgentTool(
    "apple_workspace_exec",
    { service: "missing", command: ["uname"] },
    { threadId: "thread-a" },
  );
  expect(result).toMatchObject({ isError: true });
  expect(toolResponseSchema.parse(result).content[0]!.text).toContain(
    "Unknown workspace service",
  );
  expect(h.experimental_hostRpcCalls).toHaveLength(0);
});

it("recovers the host's new pin when replacement fails after saving its manifest", async () => {
  const next = { ...profile, app: { ...profile.app, image: "node:24" } };
  const { harness: h, bb } = await setup(
    async (input) => {
      const { workspace } = hostContract.workspace.input.parse(input);
      if (workspace.action === "recreate") throw new Error("App not ready");
      return runningWorkspace(input);
    },
    undefined,
    undefined,
    () => ({
      projectId: "project-a",
      environmentId: "env-a",
      path: "/work/env-a",
      profile: next,
    }),
  );
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  await h.behavior.callRpc("workspace", {
    environmentId: "env-a",
    action: "ensure",
  });
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile: next,
  });
  await expect(
    h.behavior.callRpc("workspace", {
      environmentId: "env-a",
      action: "recreate",
    }),
  ).rejects.toThrow("App not ready");
  expect(await bb.storage.kv.get("workspace:env-a")).toMatchObject({
    profile: next,
  });
  await h.behavior.callRpc("workspace", {
    environmentId: "env-a",
    action: "ensure",
  });
  expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
    input: { workspace: { profile: next } },
  });
});

it.each([false, true])(
  "retires a failed replacement of a stopped recipe (manifest read unavailable: %s)",
  async (unavailable) => {
    let metadataUnavailable = false;
    const s = await setup(
      async (input) => {
        const { workspace } = hostContract.workspace.input.parse(input);
        if (workspace.action === "recreate") throw new Error("App not ready");
        return runningWorkspace(input);
      },
      undefined,
      undefined,
      () => {
        if (metadataUnavailable) throw new Error("Host unreachable");
        return {
          projectId: "project-a",
          environmentId: "env-a",
          path: "/work/env-a",
          profile,
        };
      },
    );
    const h = s.harness;
    await h.behavior.callRpc("saveWorkspaceProfile", {
      projectId: "project-a",
      profile,
    });
    await h.behavior.callRpc("workspace", {
      environmentId: "env-a",
      action: "ensure",
    });
    await h.behavior.callRpc("workspace", {
      environmentId: "env-a",
      action: "stop",
    });
    expect(await s.bb.storage.kv.get("workspace:env-a")).toMatchObject({
      stopped: true,
    });
    metadataUnavailable = unavailable;
    await expect(
      h.behavior.callRpc("workspace", {
        environmentId: "env-a",
        action: "recreate",
      }),
    ).rejects.toThrow("App not ready");
    expect(await s.bb.storage.kv.get("workspace:env-a")).toMatchObject({
      stopped: false,
    });
    metadataUnavailable = false;
    s.destroy();
    await h.behavior.runSchedule("retire-project-containers");
    expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "workspace",
      input: { workspace: { action: "stop", profile } },
    });
    expect(await s.bb.storage.kv.get("workspace:env-a")).toMatchObject({
      stopped: true,
    });
  },
);

it("records a first replacement attempt for retirement when its outcome is unknown", async () => {
  const s = await setup(async (input) => {
    const { workspace } = hostContract.workspace.input.parse(input);
    if (workspace.action === "recreate") throw new Error("Connection lost");
    return runningWorkspace(input);
  });
  const h = s.harness;
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  await expect(
    h.behavior.callRpc("workspace", {
      environmentId: "env-a",
      action: "recreate",
    }),
  ).rejects.toThrow("Connection lost");
  expect(await s.bb.storage.kv.get("workspace:env-a")).toMatchObject({
    profile,
    stopped: false,
  });
  s.destroy();
  await h.behavior.runSchedule("retire-project-containers");
  expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
    method: "workspace",
    input: { workspace: { action: "stop" } },
  });
});

it.each(["retire", "stop", "teardown"] as const)(
  "reconciles a changed host path after uncertain replacement before %s",
  async (cleanup) => {
    let target: WorkspaceTarget | null = null;
    let metadataUnavailable = false;
    const s = await setup(
      async (input) => {
        const { workspace } = hostContract.workspace.input.parse(input);
        if (workspace.action === "recreate") {
          const { action: _action, ...saved } = workspace;
          target = saved;
          throw new Error("Connection lost after manifest save");
        }
        if (target && workspace.path !== target.path)
          throw new Error("Workspace path mismatch");
        return runningWorkspace(input);
      },
      undefined,
      (input) => {
        const { workspace } = hostContract.workspaceTeardown.input.parse(input);
        if (!target || workspace.path !== target.path)
          throw new Error("Workspace path mismatch");
        return {
          kind: "removed",
          environmentId: workspace.environmentId,
          containers: [],
          networks: [],
          volumes: [],
          retainedVolumes: [],
        };
      },
      () => {
        if (metadataUnavailable) throw new Error("Host unreachable");
        return target;
      },
    );
    const h = s.harness;
    await h.behavior.callRpc("saveWorkspaceProfile", {
      projectId: "project-a",
      profile,
    });
    await h.behavior.callRpc("workspace", {
      environmentId: "env-a",
      action: "ensure",
    });
    await h.behavior.callRpc("workspace", {
      environmentId: "env-a",
      action: "stop",
    });
    s.setPath("env-a", "/work/restored-env-a");
    metadataUnavailable = true;
    await expect(
      h.behavior.callRpc("workspace", {
        environmentId: "env-a",
        action: "recreate",
      }),
    ).rejects.toThrow("Connection lost");
    expect(await s.bb.storage.kv.get("workspace:env-a")).toMatchObject({
      path: "/work/env-a",
      stopped: false,
    });
    metadataUnavailable = false;
    if (cleanup === "retire") {
      s.destroy();
      await h.behavior.runSchedule("retire-project-containers");
    } else if (cleanup === "stop") {
      await h.behavior.callRpc("workspace", {
        environmentId: "env-a",
        action: "stop",
      });
    } else {
      expect(
        await h.behavior.callAgentTool(
          "apple_workspace_teardown",
          {},
          { threadId: "thread-a" },
        ),
      ).not.toMatchObject({ isError: true });
    }
    expect(await s.bb.storage.kv.get("workspace:env-a")).toMatchObject({
      path: "/work/restored-env-a",
      stopped: true,
    });
  },
);

it("reports first-use exec provisioning and retains its readiness failure", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { harness: h } = await setup(async (input) => {
    const { workspace } = hostContract.workspace.input.parse(input);
    if (workspace.action === "ensure") {
      await pending;
      throw new Error("App did not pass its readiness check");
    }
    return runningWorkspace(input);
  });
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile: { ...profile, autoStart: false },
  });
  const before = h.realtimeSignals.length;
  const execution = h.behavior.callAgentTool(
    "apple_workspace_exec",
    { command: ["uname"] },
    { threadId: "thread-a" },
  );
  let result: unknown;
  try {
    await vi.waitFor(
      () =>
        expect(
          h.experimental_hostRpcCalls.some((c) => c.method === "workspace"),
        ).toBe(true),
      { timeout: 200, interval: 5 },
    );
    expect(
      await h.behavior.callRpc("threadWorkspace", {
        threadId: "same-worktree",
      }),
    ).toMatchObject({ inspection: { kind: "busy", operation: "ensure" } });
  } finally {
    release();
    result = await execution;
  }
  expect(result).toMatchObject({ isError: true });
  expect(
    h.experimental_hostRpcCalls.some((c) => c.method === "workspaceExec"),
  ).toBe(false);
  expect(
    await h.behavior.callRpc("threadWorkspace", { threadId: "thread-a" }),
  ).toMatchObject({
    lastError: "App did not pass its readiness check",
    inspection: { kind: "observed" },
  });
  expect(h.realtimeSignals.slice(before).map((s) => s.channel)).toEqual([
    "workspaces-changed",
    "workspaces-changed",
  ]);
});

it("uses validated host contracts for workspace exec and disables all workspace tools live", async () => {
  const { harness: h } = await setup();
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  expect(
    await h.behavior.callAgentTool("apple_workspace_exec", {
      command: ["uname"],
    }),
  ).not.toMatchObject({ isError: true });
  expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
    method: "workspaceExec",
    hostId: "mac-a",
    input: { exec: { service: "app", command: ["uname"] } },
  });
  const before = h.experimental_hostRpcCalls.length;
  await h.behavior.setSettings({ enableAgentTools: false });
  expect(await h.behavior.callAgentTool("apple_workspace", {})).toMatchObject({
    isError: true,
  });
  expect(
    await h.behavior.callAgentTool("apple_workspace_exec", {
      command: ["uname"],
    }),
  ).toMatchObject({ isError: true });
  expect(
    await h.behavior.callAgentTool("apple_workspace_setup", {}),
  ).toMatchObject({ isError: true });
  expect(
    await h.behavior.callAgentTool("apple_workspace_setup", { profile }),
  ).toMatchObject({ isError: true });
  expect(h.experimental_hostRpcCalls).toHaveLength(before);
});
it("lets an agent read project defaults and presets before any profile is enabled", async () => {
  const { harness: h } = await setup();
  const result = toolResponseSchema.parse(
    await h.behavior.callAgentTool(
      "apple_workspace_setup",
      {},
      { threadId: "thread-a", projectId: "another-project" },
    ),
  );
  expect(result.isError).not.toBe(true);
  const block = result.content.find((v) => v.type === "text");
  if (block?.type !== "text") throw new Error("Expected setup instructions");
  const response: unknown = JSON.parse(block.text);
  expect(response).toEqual({
    projectId: "project-a",
    profile: null,
    defaultProfile: defaultWorkspaceProfile(),
    databasePresets: {
      postgres: databasePreset("postgres", ".env.containers.database"),
      mysql: databasePreset("mysql", ".env.containers.database"),
    },
  });
  expect(h.experimental_hostRpcCalls).toHaveLength(0);
  expect(await h.behavior.callRpc("workspaceProjects", null)).toMatchObject([
    { profile: null },
  ]);
  const configuration = await h.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext(),
  );
  expect(
    configuration.tools.map((tool) =>
      typeof tool === "string" ? tool : tool.name,
    ),
  ).toContain("apple_workspace_setup");
});
it("lets an agent save a project setup, reload it and start the same saved recipe without UI setup", async () => {
  const { harness: h } = await setup();
  const configured = {
    ...defaultWorkspaceProfile(),
    enabled: true,
    autoStart: false,
    services: [databasePreset("postgres", ".env.containers.database")],
  };
  const result = await h.behavior.callAgentTool(
    "apple_workspace_setup",
    { profile: configured },
    { threadId: "thread-a" },
  );
  expect(result).not.toMatchObject({ isError: true });
  expect(h.experimental_hostRpcCalls).toHaveLength(0);
  expect(await h.behavior.callRpc("workspaceProjects", null)).toEqual([
    { id: "project-a", name: "Demo", profile: configured },
  ]);
  const { harness: reloaded } = await h.lifecycle.reload(plugin);
  disposers.push(() => reloaded.lifecycle.dispose());
  const read = toolResponseSchema.parse(
    await reloaded.behavior.callAgentTool("apple_workspace_setup", {}),
  );
  const block = read.content.find((v) => v.type === "text");
  if (block?.type !== "text") throw new Error("Expected a saved profile");
  const parsed = z
    .object({ projectId: z.string(), profile: workspaceProfileSchema })
    .parse(JSON.parse(block.text));
  expect(parsed).toEqual({ projectId: "project-a", profile: configured });
  expect(
    await reloaded.behavior.callAgentTool("apple_workspace", {}),
  ).not.toMatchObject({ isError: true });
  expect(reloaded.experimental_hostRpcCalls.at(-1)).toMatchObject({
    method: "workspace",
    input: {
      workspace: {
        projectId: "project-a",
        profile: configured,
        action: "ensure",
      },
    },
  });
});
it("rejects invalid agent profiles and project overrides without changing stored setup", async () => {
  const { harness: h } = await setup();
  await expect(
    h.behavior.callAgentTool("apple_workspace_setup", {
      projectId: "other-project",
      profile,
    }),
  ).rejects.toThrow();
  await expect(
    h.behavior.callAgentTool("apple_workspace_setup", {
      profile: {
        ...profile,
        services: [
          { name: "database", image: "postgres:17", envFile: "../outside.env" },
        ],
      },
    }),
  ).rejects.toThrow();
  expect(await h.behavior.callRpc("workspaceProjects", null)).toMatchObject([
    { profile: null },
  ]);
  expect(h.experimental_hostRpcCalls).toHaveLength(0);
});
it("starts opted-in project containers on activity and stops them only after environment removal", async () => {
  const s = await setup(),
    h = s.harness;
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  const thread = makeThreadResponse({
    projectId: "project-a",
    environmentId: "env-a",
  });
  await h.behavior.emitThreadEvent("thread.active", { thread });
  expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
    input: { workspace: { action: "ensure" } },
  });
  const before = h.experimental_hostRpcCalls.length;
  await h.behavior.emitThreadEvent("thread.archived", { thread });
  expect(h.experimental_hostRpcCalls).toHaveLength(before);
  s.destroy();
  await h.behavior.runSchedule("retire-project-containers");
  expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
    input: { workspace: { action: "stop" } },
  });
  const after = h.experimental_hostRpcCalls.length;
  await h.behavior.runSchedule("retire-project-containers");
  expect(h.experimental_hostRpcCalls).toHaveLength(after);
});

it("offers teardown to agents, scopes it to the invoking environment and retains data by default", async () => {
  const { harness: h } = await setup();
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  const configuration = await h.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ project: { id: "project-a" } }),
  );
  expect(configuration.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "apple_workspace_teardown" }),
    ]),
  );
  expect(JSON.stringify(configuration.instructions)).toContain(
    "When the task is finished",
  );
  const result = await h.behavior.callAgentTool(
    "apple_workspace_teardown",
    {},
    { threadId: "thread-b" },
  );
  expect(result).not.toMatchObject({ isError: true });
  expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
    method: "workspaceTeardown",
    hostId: "mac-a",
    input: {
      workspace: {
        projectId: "project-a",
        environmentId: "env-b",
        path: "/work/env-b",
      },
      options: { removeVolumes: false, dryRun: false },
    },
  });
  expect(
    JSON.parse(toolResponseSchema.parse(result).content[0]!.text),
  ).toMatchObject({ kind: "removed", retainedVolumes: ["data"] });
  await expect(
    h.behavior.callAgentTool("apple_workspace_teardown", {
      environmentId: "env-a",
    }),
  ).rejects.toThrow();
  await h.behavior.setSettings({ enableAgentTools: false });
  const calls = h.experimental_hostRpcCalls.length;
  expect(
    await h.behavior.callAgentTool("apple_workspace_teardown", {}),
  ).toMatchObject({ isError: true });
  expect(h.experimental_hostRpcCalls).toHaveLength(calls);
});

it("protects active shared-worktree threads, including hidden/paginated siblings, but excludes the caller", async () => {
  const s = await setup(),
    h = s.harness;
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  s.setThreads([
    ...Array.from({ length: 100 }, (_, i) =>
      makeThreadResponse({
        id: `idle-${i}`,
        environmentId: "env-a",
        status: "idle",
      }),
    ),
    makeThreadResponse({
      id: "other-active",
      environmentId: "env-a",
      status: "active",
      title: "Shared task",
    }),
    makeThreadResponse({
      id: "thread-a",
      environmentId: "env-a",
      status: "active",
    }),
    makeThreadResponse({
      id: "separate-worktree",
      environmentId: "env-b",
      status: "active",
    }),
  ]);
  const result = await h.behavior.callAgentTool(
    "apple_workspace_teardown",
    {},
    { threadId: "thread-a" },
  );
  expect(result).toMatchObject({ isError: true });
  expect(
    JSON.parse(toolResponseSchema.parse(result).content[0]!.text),
  ).toMatchObject({
    kind: "in-use",
    threads: [{ threadId: "other-active", title: "Shared task" }],
  });
  expect(h.experimental_hostRpcCalls).toHaveLength(0);
  s.setThreads([
    makeThreadResponse({
      id: "thread-a",
      environmentId: "env-a",
      status: "active",
    }),
  ]);
  expect(
    await h.behavior.callAgentTool(
      "apple_workspace_teardown",
      {},
      { threadId: "thread-a" },
    ),
  ).not.toMatchObject({ isError: true });
});

it("supports CLI dry runs and explicit data removal without saving a binding during preview", async () => {
  const { harness: h, bb } = await setup();
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  const signals = h.realtimeSignals.length;
  const preview = await h.behavior.runCli([
    "workspace",
    "teardown",
    "--environment",
    "env-b",
    "--dry-run",
    "--remove-volumes",
    "--json",
  ]);
  expect(preview).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(preview.stdout)).toMatchObject({
    kind: "preview",
    volumes: ["data"],
    retainedVolumes: [],
  });
  expect(await bb.storage.kv.get("workspace:env-b")).toBeUndefined();
  expect(h.realtimeSignals).toHaveLength(signals);
  const removed = await h.behavior.runCli(
    ["workspace", "teardown", "--remove-volumes", "--json"],
    { threadId: "thread-b" },
  );
  expect(removed).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(removed.stdout)).toMatchObject({
    kind: "removed",
    environmentId: "env-b",
    volumes: ["data"],
  });
  expect(await bb.storage.kv.get("workspace:env-b")).toMatchObject({
    stopped: true,
  });
});

it("cleans a pinned environment even after the project setup is disabled and reports host failures", async () => {
  const s = await setup(undefined, undefined, () => {
      throw new Error("Mac offline");
    }),
    h = s.harness;
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  await h.behavior.callAgentTool(
    "apple_workspace",
    {},
    { threadId: "thread-a" },
  );
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile: { ...profile, enabled: false },
  });
  const result = await h.behavior.callAgentTool(
    "apple_workspace_teardown",
    {},
    { threadId: "thread-a" },
  );
  expect(result).toMatchObject({ isError: true });
  expect(toolResponseSchema.parse(result).content[0]!.text).toContain(
    "Mac offline",
  );
  expect(await s.bb.storage.kv.get("workspace:env-a")).toMatchObject({
    stopped: false,
  });
  expect(
    await h.behavior.callRpc("threadWorkspace", {
      threadId: "thread-a",
      inspect: false,
    }),
  ).toMatchObject({ lastError: "Mac offline" });
});

it("refuses teardown during a container command and shows cleanup while the host is pending", async () => {
  let entered!: () => void,
    release!: () => void,
    cleanupEntered!: () => void,
    cleanupRelease!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cleanupStarted = new Promise<void>((resolve) => {
    cleanupEntered = resolve;
  });
  const cleanupPending = new Promise<void>((resolve) => {
    cleanupRelease = resolve;
  });
  const { harness: h } = await setup(
    runningWorkspace,
    async () => {
      entered();
      await pending;
      return success();
    },
    async () => {
      cleanupEntered();
      await cleanupPending;
      return {
        kind: "removed",
        environmentId: "env-a",
        containers: [],
        networks: [],
        volumes: [],
        retainedVolumes: [],
      };
    },
  );
  await h.behavior.callRpc("saveWorkspaceProfile", {
    projectId: "project-a",
    profile,
  });
  const command = h.behavior.callAgentTool(
    "apple_workspace_exec",
    { command: ["sleep", "10"] },
    { threadId: "thread-a" },
  );
  await started;
  try {
    const result = await h.behavior.callAgentTool(
      "apple_workspace_teardown",
      {},
      { threadId: "thread-a" },
    );
    expect(result).toMatchObject({ isError: true });
    expect(toolResponseSchema.parse(result).content[0]!.text).toContain(
      "still in progress",
    );
    expect(
      h.experimental_hostRpcCalls.some((c) => c.method === "workspaceTeardown"),
    ).toBe(false);
  } finally {
    release();
    await command;
  }
  const cleanup = h.behavior.callAgentTool(
    "apple_workspace_teardown",
    {},
    { threadId: "thread-a" },
  );
  await cleanupStarted;
  try {
    expect(
      await h.behavior.callRpc("threadWorkspace", { threadId: "thread-a" }),
    ).toMatchObject({ inspection: { kind: "busy", operation: "teardown" } });
  } finally {
    cleanupRelease();
    await cleanup;
  }
  expect(
    await h.behavior.callRpc("threadWorkspace", {
      threadId: "thread-a",
      inspect: false,
    }),
  ).toMatchObject({
    inspection: { kind: "checking", state: { configured: false } },
  });
});
