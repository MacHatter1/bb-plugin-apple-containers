import { afterEach, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { hostContract } from "../contract";
import { readySnapshot, success } from "./fixtures";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
async function setup(
  options: { loseRun?: boolean; offline?: () => boolean } = {},
) {
  const fake = createFakePluginHost({
    pluginId: "apple-containers",
    agentSkillIds: ["apple-containers"],
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "project-a",
            environmentId: "env-a",
          }),
      },
      environments: { get: async () => ({ hostId: "mac-a" }) },
      projects: { list: async () => [{ id: "project-a", name: "Project A" }] },
    },
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      if (method === "perform") {
        if (options.loseRun) throw new Error("Launch response lost");
        return success();
      }
      if (method === "cleanupContainers") {
        const { dryRun } = hostContract.cleanupContainers.input.parse(input);
        if (hostId === "mac-b" && options.offline?.())
          throw new Error("Mac offline");
        return {
          kind: dryRun ? "preview" : "removed",
          planned: ["worker"],
          removed: dryRun ? [] : ["worker"],
          retained: ["keep"],
          errors: [],
        };
      }
      if (method === "snapshot")
        return {
          ...readySnapshot,
          containers: [
            {
              ...readySnapshot.containers[0]!,
              projectId: "project-a",
              ownerThreadId: "thread-a",
            },
          ],
        };
      throw new Error(`Unexpected host method ${method}`);
    },
  });
  await plugin(fake.bb);
  disposers.push(() => fake.harness.lifecycle.dispose());
  return fake.harness;
}

it("records the owning project/thread and Mac before a launch response is lost, surviving reload", async () => {
  const h = await setup({ loseRun: true });
  const result = await h.behavior.callAgentTool(
    "apple_container_run",
    { name: "worker", image: "alpine", hostId: "mac-b" },
    { threadId: "thread-a" },
  );
  expect(result).toMatchObject({ isError: true });
  expect(h.experimental_hostRpcCalls[0]).toMatchObject({
    method: "perform",
    hostId: "mac-b",
    input: {
      owner: {
        threadId: "thread-a",
        projectId: "project-a",
        environmentId: "env-a",
      },
    },
  });
  const { harness: reloaded } = await h.lifecycle.reload(plugin);
  disposers.push(() => reloaded.lifecycle.dispose());
  const cleanup = await reloaded.behavior.callAgentTool(
    "apple_container_cleanup",
    {},
    { threadId: "thread-a" },
  );
  expect(cleanup).toMatchObject({ isError: false });
  expect(reloaded.experimental_hostRpcCalls.at(-1)).toMatchObject({
    method: "cleanupContainers",
    hostId: "mac-b",
    input: {
      owner: { threadId: "thread-a", projectId: "project-a" },
      dryRun: false,
    },
  });
});

it("cleans only the caller's recorded Macs and retains failed targets for retry", async () => {
  let offline = true;
  const h = await setup({ offline: () => offline });
  for (const hostId of ["mac-a", "mac-b"])
    await h.behavior.callAgentTool(
      "apple_container_run",
      { name: "worker", image: "alpine", hostId },
      { threadId: "thread-a" },
    );
  const count = h.experimental_hostRpcCalls.length;
  await h.behavior.callAgentTool(
    "apple_container_cleanup",
    {},
    { threadId: "thread-b" },
  );
  expect(h.experimental_hostRpcCalls).toHaveLength(count);
  expect(
    await h.behavior.callAgentTool(
      "apple_container_cleanup",
      { dryRun: true },
      { threadId: "thread-a" },
    ),
  ).toMatchObject({ isError: true });
  expect(
    h.experimental_hostRpcCalls.slice(-2).map((call) => call.input),
  ).toEqual([
    expect.objectContaining({ dryRun: true }),
    expect.objectContaining({ dryRun: true }),
  ]);
  offline = false;
  expect(
    await h.behavior.callAgentTool(
      "apple_container_cleanup",
      {},
      { threadId: "thread-a" },
    ),
  ).toMatchObject({ isError: false });
  expect(
    h.experimental_hostRpcCalls.slice(-2).map((call) => call.hostId),
  ).toEqual(["mac-a", "mac-b"]);
});

it("tracks CLI runs and exposes dry-run cleanup with a required thread outside BB", async () => {
  const h = await setup();
  expect(
    (
      await h.behavior.runCli(
        ["run", "alpine", "--name", "keep", "--cleanup", "manual"],
        { threadId: "thread-a" },
      )
    ).exitCode,
  ).toBe(0);
  expect(h.experimental_hostRpcCalls.at(-1)).toMatchObject({
    input: { command: { cleanup: "manual" }, owner: { threadId: "thread-a" } },
  });
  const preview = await h.behavior.runCli(
    ["cleanup", "--thread", "thread-a", "--dry-run", "--json"],
    { threadId: undefined },
  );
  expect(preview.exitCode).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({
    kind: "preview",
    hosts: [{ hostId: "mac-a", result: { kind: "preview" } }],
  });
  expect(
    (await h.behavior.runCli(["cleanup"], { threadId: undefined })).exitCode,
  ).not.toBe(0);
});

it("groups new agent containers using their project labels and always supplies cleanup guidance", async () => {
  const h = await setup();
  expect(
    await h.behavior.callRpc("snapshot", { hostId: "mac-a" }),
  ).toMatchObject({
    containers: [{ project: { id: "project-a", name: "Project A" } }],
  });
  const config = await h.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext(),
  );
  expect(config.tools).toContainEqual(
    expect.objectContaining({ name: "apple_container_cleanup" }),
  );
  expect(config.instructions).toContain("cleanup=manual");
  await h.behavior.setSettings({ enableAgentTools: false });
  const count = h.experimental_hostRpcCalls.length;
  expect(
    await h.behavior.callAgentTool("apple_container_cleanup", {}),
  ).toMatchObject({ isError: true });
  expect(h.experimental_hostRpcCalls).toHaveLength(count);
});

it("rejects a forged cleanup scope in native tool parameters", async () => {
  const h = await setup();
  await expect(
    h.behavior.callAgentTool("apple_container_cleanup", {
      threadId: "someone-else",
      hostId: "mac-b",
    }),
  ).rejects.toThrow();
  expect(h.experimental_hostRpcCalls).toHaveLength(0);
});
