import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { readySnapshot, success } from "./fixtures";
import { workspaceKey } from "../lib/workspace-runtime";
import type { Snapshot } from "../contract";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
async function setup(snapshot: Snapshot = readySnapshot) {
  const fake = createFakePluginHost({
    pluginId: "apple-containers",
    agentSkillIds: ["apple-containers"],
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host-a", name: "Demo Mac" }),
        ],
      },
      threads: {
        get: async () => makeThreadResponse({ environmentId: "env-a" }),
      },
      environments: { get: async () => ({ hostId: "thread-mac" }) },
    },
    experimental_callHostRpc: async ({ method }) =>
      method === "snapshot" ? structuredClone(snapshot) : success("done"),
  });
  await plugin(fake.bb);
  disposers.push(() => fake.harness.lifecycle.dispose());
  return fake.harness;
}
describe("BB integration", () => {
  it("persists explicit project links through reload without changing container state", async () => {
    const h = await setup();
    const project = { id: "project-a", name: "Learn Anything" };
    h.sdk.stub("projects.get", async () => project);
    h.sdk.stub("projects.list", async () => [project]);
    const command = [
      "link-project",
      "demo-workspace",
      "--host",
      "host-a",
      "--project",
      project.id,
      "--json",
    ];
    const result = await h.behavior.runCli(command);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: "demo-workspace",
      project,
    });
    const { harness: reloaded } = await h.lifecycle.reload(plugin);
    disposers.push(() => reloaded.lifecycle.dispose());
    reloaded.sdk.stub("projects.list", async () => [project]);
    expect(
      await reloaded.behavior.callRpc("snapshot", { hostId: "host-a" }),
    ).toMatchObject({
      containers: [{ id: "demo-workspace", project }],
    });
    expect(
      await reloaded.behavior.callRpc("snapshot", { hostId: "host-b" }),
    ).toEqual(readySnapshot);
    expect(
      reloaded.experimental_hostRpcCalls.every(
        (call) => call.method === "snapshot",
      ),
    ).toBe(true);
  });
  it("does not transfer an explicit link when a container name is reused", async () => {
    const snapshot = structuredClone(readySnapshot);
    const h = await setup(snapshot);
    const project = { id: "project-a", name: "Learn Anything" };
    h.sdk.stub("projects.get", async () => project);
    h.sdk.stub("projects.list", async () => [project]);
    await h.behavior.callRpc("linkContainerProject", {
      hostId: "host-a",
      id: "demo-workspace",
      projectId: project.id,
    });
    snapshot.containers[0]!.createdAt = "2026-10-24T15:00:00Z";
    expect(await h.behavior.callRpc("snapshot", { hostId: "host-a" })).toEqual(
      snapshot,
    );
  });
  it.each([
    { managed: false, message: "Only BB-managed" },
    {
      managed: true,
      project: { id: "another-project", name: "Another project" },
      message: "already linked",
    },
  ])(
    "rejects invalid project linking: $message",
    async ({ message, ...overrides }) => {
      const h = await setup({
        ...readySnapshot,
        containers: [{ ...readySnapshot.containers[0]!, ...overrides }],
      });
      h.sdk.stub("projects.get", async () => ({
        id: "project-a",
        name: "Learn Anything",
      }));
      await expect(
        h.behavior.callRpc("linkContainerProject", {
          hostId: "host-a",
          id: "demo-workspace",
          projectId: "project-a",
        }),
      ).rejects.toThrow(message);
      expect(h.realtimeSignals).toHaveLength(0);
    },
  );
  it("rejects links to missing projects or missing containers", async () => {
    const h = await setup();
    h.sdk.stub("projects.get", async () => {
      throw new Error("Project not found");
    });
    const input = {
      hostId: "host-a",
      id: "demo-workspace",
      projectId: "missing",
    };
    await expect(
      h.behavior.callRpc("linkContainerProject", input),
    ).rejects.toThrow("Project not found");
    expect(h.experimental_hostRpcCalls).toHaveLength(0);
    h.sdk.stub("projects.get", async () => ({
      id: "project-a",
      name: "Learn Anything",
    }));
    await expect(
      h.behavior.callRpc("linkContainerProject", {
        ...input,
        id: "missing",
        projectId: "project-a",
      }),
    ).rejects.toThrow("not found on the selected Mac");
    expect(h.realtimeSignals).toHaveLength(0);
  });
  it("groups existing workspace containers from multiple checkouts under their project", async () => {
    const base = readySnapshot.containers[0]!;
    const key = (environmentId: string) =>
      workspaceKey({ projectId: "project-a", environmentId });
    const h = await setup({
      ...readySnapshot,
      containers: [
        { ...base, id: "checkout-app", workspaceKey: key("checkout") },
        { ...base, id: "worktree-db", workspaceKey: key("worktree") },
        { ...base, id: "retired-app", workspaceKey: key("retired") },
        { ...base, id: "orphan", workspaceKey: "unknown" },
        {
          ...base,
          id: "external",
          managed: false,
          workspaceKey: key("checkout"),
        },
        base,
      ],
    });
    h.sdk.stub("projects.list", async () => [
      { id: "project-a", name: "Learn Anything" },
    ]);
    h.sdk.stub("environments.list", async ({ status }) =>
      status === "destroyed"
        ? [{ id: "retired", projectId: "project-a" }]
        : [
            { id: "checkout", projectId: "project-a" },
            { id: "worktree", projectId: "project-a" },
          ],
    );
    const state = (await h.behavior.callRpc("snapshot", {
      hostId: "host-a",
    })) as Snapshot;
    expect(state.containers.slice(0, 3).map((c) => c.project)).toEqual([
      { id: "project-a", name: "Learn Anything" },
      { id: "project-a", name: "Learn Anything" },
      { id: "project-a", name: "Learn Anything" },
    ]);
    expect(
      state.containers.slice(3).every((c) => c.project === undefined),
    ).toBe(true);
    expect(h.sdk.calls).toContainEqual(
      expect.objectContaining({
        path: "environments.list",
        args: [
          expect.objectContaining({ hostId: "host-a", offset: 0, limit: 500 }),
        ],
      }),
    );
    expect(h.experimental_hostRpcCalls.map((call) => call.method)).toEqual([
      "snapshot",
    ]);
  });
  it("names the workspaces behind leftover networks and volumes", async () => {
    const key = (environmentId: string) =>
      workspaceKey({ projectId: "project-a", environmentId });
    const h = await setup({
      ...readySnapshot,
      containers: [],
      networks: ["default", `bb-ws-${key("feature")}`, `bb-ws-${key("old")}`],
      volumes: [`bb-ws-${key("old")}-database-data`],
    });
    h.sdk.stub("projects.list", async () => [
      { id: "project-a", name: "Learn Anything" },
    ]);
    const environment = (id: string, phase: string) => ({
      id,
      projectId: "project-a",
      isWorktree: true,
      branchName: `${id}-branch`,
      name: id,
      lifecycle: { phase },
    });
    h.sdk.stub("environments.list", async ({ status }) =>
      status === "destroyed"
        ? [environment("old", "destroyed")]
        : [environment("feature", "active")],
    );
    const state = (await h.behavior.callRpc("snapshot", {
      hostId: "host-a",
    })) as Snapshot;
    expect(state.workspaces).toEqual({
      [key("feature")]: {
        projectId: "project-a",
        project: "Learn Anything",
        environment: "feature-branch",
        removed: false,
      },
      [key("old")]: {
        projectId: "project-a",
        project: "Learn Anything",
        environment: "old-branch",
        removed: true,
      },
    });
  });
  it("keeps containers available when project metadata cannot be read", async () => {
    const h = await setup({
      ...readySnapshot,
      containers: [
        { ...readySnapshot.containers[0]!, workspaceKey: "workspace-key" },
      ],
    });
    h.sdk.stub("projects.list", async () => {
      throw new Error("Metadata unavailable");
    });
    const state = (await h.behavior.callRpc("snapshot", {
      hostId: "host-a",
    })) as Snapshot;
    expect(state.containers).toHaveLength(1);
    expect(state.warnings).toEqual([
      "Project groups unavailable: Metadata unavailable",
    ]);
  });
  it("serves schema-validated dashboard data and rejects invalid commands", async () => {
    const h = await setup();
    expect(await h.behavior.callRpc("hosts", null)).toEqual({
      hosts: [{ id: "host-a", name: "Demo Mac" }],
    });
    expect(await h.behavior.callRpc("snapshot", { hostId: "host-a" })).toEqual(
      readySnapshot,
    );
    await expect(
      h.behavior.callRpc("perform", {
        hostId: "host-a",
        command: { op: "delete", id: "--all" },
      }),
    ).rejects.toThrow();
  });
  it("routes native tools to the invoking thread's environment machine", async () => {
    const h = await setup();
    await h.behavior.callAgentTool(
      "apple_container_exec",
      { id: "demo", command: ["uname", "-a"] },
      { threadId: "thread-a" },
    );
    expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
      hostId: "thread-mac",
      method: "perform",
      input: { command: { op: "exec", command: ["uname", "-a"] } },
    });
  });
  it("honours an explicit host override and forwards settings live", async () => {
    const h = await setup();
    await h.behavior.setSettings({ allowExternal: true });
    await h.behavior.callAgentTool("apple_container_manage", {
      action: "stop",
      id: "demo",
      hostId: "other-mac",
    });
    expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
      hostId: "other-mac",
      input: { config: { allowExternal: true } },
    });
    expect(h.realtimeSignals).toHaveLength(1);
  });
  it("disables native tool selection and rejects already-selected calls", async () => {
    const h = await setup();
    await h.behavior.setSettings({ enableAgentTools: false });
    const resolved = await h.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );
    expect(resolved.tools).toEqual([]);
    const result = await h.behavior.callAgentTool("apple_container_status", {});
    expect(result).toMatchObject({ isError: true });
    expect(h.experimental_hostRpcCalls).toHaveLength(0);
  });
  it("preserves guest flags after -- and validates CLI inputs before host calls", async () => {
    const h = await setup();
    const result = await h.behavior.runCli([
      "exec",
      "demo",
      "--",
      "sh",
      "-lc",
      "echo hello",
    ]);
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0 });
    expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
      input: { command: { command: ["sh", "-lc", "echo hello"] } },
    });
    expect(
      (await h.behavior.runCli(["run", "alpine", "--cpus", "0"])).exitCode,
    ).not.toBe(0);
  });
  it("requires an explicit machine outside threads when multiple machines exist", async () => {
    const h = await setup();
    h.sdk.stub("hosts.list", async () => [
      makeHostResponse({ id: "one" }),
      makeHostResponse({ id: "two" }),
    ]);
    const result = await h.behavior.runCli(["status"], { threadId: undefined });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--host");
  });
});
it("uses public SDK imports only", async () => {
  const scan = await experimental_scanPublicSdkOnly(
    new URL("..", import.meta.url).pathname,
    {
      allow: [
        /^vitest$/,
        /^@testing-library\/react$/,
        /^react(?:-dom)?$/,
        /^@radix-ui\/react-(slot|checkbox|dialog|popover)$/,
        /^(class-variance-authority|clsx|tailwind-merge)$/,
      ],
    },
  );
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});
