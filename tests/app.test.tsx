// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { readySnapshot, success } from "./fixtures";
import type { ContainerSummary, Snapshot } from "../contract";

let app: Awaited<ReturnType<typeof loadPluginApp>>;
beforeAll(async () => {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  app = await loadPluginApp(() => import("../app"));
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
});
async function setup(
  external = false,
  perform: (input: unknown) => unknown = () => success("container output"),
  options: {
    allowExternal?: boolean;
    enableExternal?: () => Promise<void>;
    containers?: ContainerSummary[];
    networks?: string[];
    volumes?: string[];
    workspaces?: Snapshot["workspaces"];
  } = {},
) {
  const state = structuredClone(readySnapshot);
  state.allowExternal = options.allowExternal ?? false;
  if (options.containers) state.containers = options.containers;
  if (options.networks) state.networks = options.networks;
  if (options.volumes) state.volumes = options.volumes;
  if (options.workspaces) state.workspaces = options.workspaces;
  if (external) state.containers[0]!.managed = false;
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        hosts: () => ({ hosts: [{ id: "host-demo", name: "Demo Mac" }] }),
        snapshot: () => state,
        metrics: () => ({ sampledAt: Date.now(), containers: [] }),
        diskUsage: () => ({
          containers: {
            total: 2,
            active: 1,
            sizeInBytes: 4096,
            reclaimable: 2048,
          },
          images: { total: 3, active: 1, sizeInBytes: 4096, reclaimable: 2048 },
          volumes: {
            total: 2,
            active: 1,
            sizeInBytes: 4096,
            reclaimable: 2048,
          },
        }),
        perform,
      },
      sdk: {
        plugins: {
          updateSettings: async () => {
            await options.enableExternal?.();
            state.allowExternal = true;
            return { ok: true, schema: {}, values: { allowExternal: true } };
          },
        },
      },
    },
  );
  cleanup.push(() => slot.lifecycle.unmount());
  await slot.findByText("Services running");
  return slot;
}
it("opens the container workspace and protects external containers", async () => {
  const slot = await setup(true);
  fireEvent.click(slot.getByRole("button", { name: "Open demo-workspace" }));
  await slot.findByText(
    "Created outside BB. Controls are protected by the allowExternal setting.",
  );
  expect(
    (slot.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(
    within(slot.getByRole("navigation", { name: "Container views" })).getByRole(
      "button",
      { name: "Logs" },
    ),
  );
  await slot.findByText("container output");
});
it("creates a detached container using familiar command entry", async () => {
  const slot = await setup();
  fireEvent.click(slot.getByRole("button", { name: "New container" }));
  fireEvent.change(slot.getByLabelText("Name"), {
    target: { value: "demo-new" },
  });
  expect(
    slot.getByRole("region", { name: "Command preview" }).querySelector("pre")
      ?.textContent,
  ).toBe(
    [
      "container run --detach",
      "--name demo-new",
      "--label app.getbb.apple-containers.managed=true",
      "--cpus 2",
      "--memory 1024M",
      "alpine:3.23 sleep infinity",
    ].join(" \\\n  "),
  );
  fireEvent.click(slot.getByRole("button", { name: "Create container" }));
  await slot.findByText("Created demo-new.");
  expect(slot.inspection.rpcCalls).toContainEqual(
    expect.objectContaining({
      method: "perform",
      input: expect.objectContaining({
        hostId: "host-demo",
        command: expect.objectContaining({
          op: "run",
          name: "demo-new",
          command: ["sleep", "infinity"],
        }),
      }),
    }),
  );
});
it("rejects an unfinished quoted command before calling the backend", async () => {
  const slot = await setup();
  fireEvent.click(slot.getByRole("button", { name: "New container" }));
  fireEvent.change(slot.getByLabelText("Name"), {
    target: { value: "demo-new" },
  });
  fireEvent.change(slot.getByLabelText("Container command"), {
    target: { value: 'echo "unfinished' },
  });
  fireEvent.click(slot.getByRole("button", { name: "Create container" }));
  await slot.findByText("Close the quote in the command.");
  expect(
    slot.inspection.rpcCalls.filter((c) => c.method === "perform"),
  ).toHaveLength(0);
});
it("filters containers and switches to the image library", async () => {
  const slot = await setup();
  const nav = within(
    slot.getByRole("navigation", { name: "Container dashboard sections" }),
  );
  fireEvent.click(nav.getByRole("button", { name: /^Containers/ }));
  fireEvent.change(slot.getByLabelText("Filter containers"), {
    target: { value: "missing" },
  });
  await slot.findByText("No matching containers");
  fireEvent.click(nav.getByRole("button", { name: /^Images/ }));
  await slot.findByText("sha256:demo");
});

it("groups containers by project and filters project names and states within each group", async () => {
  const base = readySnapshot.containers[0]!;
  const alpha = { id: "alpha", name: "Alpha" };
  const slot = await setup(false, undefined, {
    containers: [
      { ...base, id: "zulu-app", project: { id: "zulu", name: "Zulu" } },
      { ...base, id: "checkout-app", project: alpha },
      { ...base, id: "worktree-db", project: alpha, state: "stopped" },
      base,
    ],
  });
  const bay = (name: string) => within(slot.getByRole("region", { name }));
  expect(
    bay("Alpha").getByRole("button", { name: "Open checkout-app" }),
  ).toBeTruthy();
  expect(
    bay("Alpha").getByRole("button", { name: "Open worktree-db" }),
  ).toBeTruthy();
  expect(bay("Alpha").getByText("1 of 2 running")).toBeTruthy();
  expect(
    bay("Other containers").getByRole("button", {
      name: "Open demo-workspace",
    }),
  ).toBeTruthy();
  expect(
    slot
      .getAllByRole("heading", { level: 3 })
      .slice(0, 3)
      .map((h) => h.textContent),
  ).toEqual(["Alpha", "Zulu", "Other containers"]);
  expect(slot.queryByText("BB")).toBeNull();
  fireEvent.click(
    within(
      slot.getByRole("navigation", { name: "Container dashboard sections" }),
    ).getByRole("button", { name: "Containers" }),
  );
  const alphaGroup = within(slot.getByRole("region", { name: "Alpha" }));
  expect(
    alphaGroup.getByRole("button", { name: "Open checkout-app" }),
  ).toBeTruthy();
  expect(
    alphaGroup.getByRole("button", { name: "Open worktree-db" }),
  ).toBeTruthy();
  expect(alphaGroup.getByText("2")).toBeTruthy();
  expect(alphaGroup.getByRole("heading", { name: "Alpha" })).toBeTruthy();
  expect(
    within(slot.getByRole("region", { name: "Other containers" })).getByRole(
      "button",
      { name: "Open demo-workspace" },
    ),
  ).toBeTruthy();
  expect(
    slot
      .getAllByRole("heading", { level: 2 })
      .slice(0, 3)
      .map((h) => h.textContent),
  ).toEqual(["Alpha", "Zulu", "Other containers"]);
  fireEvent.change(slot.getByLabelText("Filter containers"), {
    target: { value: "alpha" },
  });
  expect(slot.queryByRole("region", { name: "Zulu" })).toBeNull();
  expect(slot.queryByRole("region", { name: "Other containers" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /^Stopped$/ }));
  expect(
    alphaGroup.queryByRole("button", { name: "Open checkout-app" }),
  ).toBeNull();
  expect(
    alphaGroup.getByRole("button", { name: "Open worktree-db" }),
  ).toBeTruthy();
  fireEvent.click(alphaGroup.getByRole("button", { name: "Open worktree-db" }));
  expect(slot.getByRole("heading", { name: "worktree-db" })).toBeTruthy();
  expect(
    within(
      slot.getByRole("region", { name: "Details for worktree-db" }),
    ).getByText("Alpha"),
  ).toBeTruthy();
});

it("keeps projects with the same name in separate groups on both views", async () => {
  const base = readySnapshot.containers[0]!;
  const slot = await setup(false, undefined, {
    containers: [
      { ...base, id: "second-app", project: { id: "b", name: "Shared name" } },
      { ...base, id: "first-app", project: { id: "a", name: "Shared name" } },
    ],
  });
  const expectSeparateGroups = () => {
    const groups = slot.getAllByRole("region", { name: "Shared name" });
    expect(groups).toHaveLength(2);
    for (const [index, id] of ["first-app", "second-app"].entries()) {
      const group = within(groups[index]!);
      expect(group.getByRole("button", { name: `Open ${id}` })).toBeTruthy();
      expect(group.getAllByRole("button", { name: /^Open / })).toHaveLength(1);
    }
  };
  expectSeparateGroups();
  fireEvent.click(
    within(
      slot.getByRole("navigation", { name: "Container dashboard sections" }),
    ).getByRole("button", { name: "Containers" }),
  );
  expectSeparateGroups();
});

async function openStorage(slot: Awaited<ReturnType<typeof setup>>) {
  fireEvent.click(
    within(
      slot.getByRole("navigation", { name: "Container dashboard sections" }),
    ).getByRole("button", { name: "Storage" }),
  );
  await slot.findByText("Container disks");
  await slot.findAllByText("2 KiB");
}

it("opens shared cleanup actions with reclaimable space before permission is enabled", async () => {
  const slot = await setup();
  await openStorage(slot);
  for (const name of [
    "Remove dangling",
    "Remove all unused",
    "Delete unattached volumes",
  ]) {
    const button = slot.getByRole("button", { name });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    const dialog = within(await slot.findByRole("dialog"));
    expect(
      dialog.getByRole("button", { name: "Enable external control & cleanup" }),
    ).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  }
  expect(slot.inspection.sdkCalls).toHaveLength(0);
  expect(
    slot.inspection.rpcCalls.filter((call) => call.method === "perform"),
  ).toHaveLength(0);
});

it("enables shared cleanup explicitly and requires a separate reclaim confirmation", async () => {
  const slot = await setup();
  await openStorage(slot);
  fireEvent.click(slot.getByRole("button", { name: "Remove all unused" }));
  const dialog = within(await slot.findByRole("dialog"));
  fireEvent.click(
    dialog.getByRole("button", { name: "Enable external control & cleanup" }),
  );
  const confirm = await dialog.findByRole("button", {
    name: "Remove unused images",
  });
  expect(slot.inspection.sdkCalls).toContainEqual({
    method: "plugins.updateSettings",
    args: [{ pluginId: "test-plugin", values: { allowExternal: true } }],
  });
  expect(
    slot.inspection.rpcCalls.filter((call) => call.method === "perform"),
  ).toHaveLength(0);
  fireEvent.click(confirm);
  await slot.findByText("Unused image cleanup completed.");
  expect(slot.inspection.rpcCalls).toContainEqual({
    method: "perform",
    input: {
      hostId: "host-demo",
      command: { op: "reclaim", target: "unused-images", confirmed: true },
    },
  });
});

it("keeps cleanup locked when saving permission fails", async () => {
  const slot = await setup(false, undefined, {
    enableExternal: async () => {
      throw new Error("Could not save permission");
    },
  });
  await openStorage(slot);
  fireEvent.click(slot.getByRole("button", { name: "Remove dangling" }));
  const dialog = within(await slot.findByRole("dialog"));
  fireEvent.click(
    dialog.getByRole("button", { name: "Enable external control & cleanup" }),
  );
  await dialog.findByText("Could not save permission");
  expect(
    dialog.queryByRole("button", { name: "Remove dangling images" }),
  ).toBeNull();
  expect(
    slot.inspection.rpcCalls.filter((call) => call.method === "perform"),
  ).toHaveLength(0);
});

it("requires data loss acknowledgment before reclaiming unattached volumes", async () => {
  const slot = await setup(false, undefined, { allowExternal: true });
  await openStorage(slot);
  fireEvent.click(
    slot.getByRole("button", { name: "Delete unattached volumes" }),
  );
  const dialog = within(await slot.findByRole("dialog"));
  const confirm = dialog.getByRole("button", {
    name: "Delete unattached volumes",
  }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.click(dialog.getByRole("checkbox"));
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  await slot.findByText("Unattached volume cleanup completed.");
  expect(slot.inspection.rpcCalls).toContainEqual({
    method: "perform",
    input: {
      hostId: "host-demo",
      command: {
        op: "reclaim",
        target: "unattached-volumes",
        confirmed: true,
        dataLossAcknowledged: true,
      },
    },
  });
});

it("keeps verbose cleanup output collapsed beneath a short completion notice", async () => {
  const output = Array.from(
    { length: 200 },
    (_, index) => `untagged image-${index}:local\ndeleted sha256:${index}`,
  ).join("\n");
  const slot = await setup(false, () => success(output), {
    allowExternal: true,
  });
  await openStorage(slot);
  fireEvent.click(slot.getByRole("button", { name: "Remove all unused" }));
  const dialog = within(await slot.findByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Remove unused images" }));
  await slot.findByText("Unused image cleanup completed.");
  expect(slot.getByRole("status").textContent).toBe(
    "Unused image cleanup completed.",
  );
  const summary = slot.getByText("View cleanup output");
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("pre")?.textContent).toBe(output);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  fireEvent.click(summary);
  expect(details.open).toBe(false);
  expect(slot.getByRole("heading", { name: "Storage", level: 1 })).toBeTruthy();

  fireEvent.click(slot.getByRole("button", { name: "New container" }));
  fireEvent.change(slot.getByLabelText("Name"), {
    target: { value: "next-operation" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Create container" }));
  await slot.findByText("Created next-operation.");
  expect(slot.queryByText("View cleanup output")).toBeNull();
});

it("switches from a slow log request to inspect without accepting stale output", async () => {
  let releaseLogs!: (value: ReturnType<typeof success>) => void;
  const logs = new Promise<ReturnType<typeof success>>((resolve) => {
    releaseLogs = resolve;
  });
  const slot = await setup(false, (input) => {
    const { command } = input as { command: { op: string } };
    return command.op === "logs" ? logs : success('{"inspection":"current"}');
  });
  fireEvent.click(slot.getByRole("button", { name: "Open demo-workspace" }));
  const views = within(
    slot.getByRole("navigation", { name: "Container views" }),
  );
  fireEvent.click(views.getByRole("button", { name: "Logs" }));
  fireEvent.click(views.getByRole("button", { name: "Inspect" }));
  await slot.findByText(/"inspection": "current"/);
  await act(async () => releaseLogs(success("stale log output")));
  expect(slot.queryByText("stale log output")).toBeNull();
  expect(slot.getByText(/"inspection": "current"/)).toBeTruthy();
});

it("groups workspace networks and volumes by project and names unused leftovers", async () => {
  const base = readySnapshot.containers[0]!;
  const live = "a".repeat(24),
    removed = "b".repeat(24),
    unknown = "c".repeat(24);
  const slot = await setup(false, undefined, {
    containers: [
      {
        ...base,
        id: "alpha-app",
        workspaceKey: live,
        project: { id: "alpha", name: "Alpha" },
      },
    ],
    networks: [
      "default",
      `bb-ws-${live}`,
      `bb-ws-${removed}`,
      `bb-ws-${unknown}`,
    ],
    volumes: [`bb-ws-${removed}-database-data`],
    workspaces: {
      [removed]: { project: "Alpha", environment: "issue-315", removed: true },
    },
  });
  const nav = within(
    slot.getByRole("navigation", { name: "Container dashboard sections" }),
  );
  fireEvent.click(nav.getByRole("button", { name: /^Networks/ }));
  const row = (region: string, name: string) =>
    within(
      within(slot.getByRole("region", { name: region }))
        .getByText(name)
        .closest("li")!,
    );
  expect(row("Alpha", `bb-ws-${live}`).getByText("1 container")).toBeTruthy();
  const leftover = row("Alpha", `bb-ws-${removed}`);
  expect(leftover.getByText("issue-315 worktree (removed)")).toBeTruthy();
  expect(leftover.getByText("Unused")).toBeTruthy();
  expect(
    row("Unknown workspaces", `bb-ws-${unknown}`).getByText("Unused"),
  ).toBeTruthy();
  expect(row("Other", "default").getByText("Default")).toBeTruthy();
  expect(slot.getByText(/2 aren’t used by any container/)).toBeTruthy();
  fireEvent.click(nav.getByRole("button", { name: /^Volumes/ }));
  expect(
    row("Alpha", `bb-ws-${removed}-database-data`).getByText(
      "database-data, issue-315 worktree (removed)",
    ),
  ).toBeTruthy();
  fireEvent.click(nav.getByRole("button", { name: /^Images/ }));
  expect(await slot.findByText("Used by 1 container")).toBeTruthy();
});
