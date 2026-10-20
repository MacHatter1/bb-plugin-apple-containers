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

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
async function setup() {
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
      method === "snapshot" ? readySnapshot : success("done"),
  });
  await plugin(fake.bb);
  disposers.push(() => fake.harness.lifecycle.dispose());
  return fake.harness;
}
describe("BB integration", () => {
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
