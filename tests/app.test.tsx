// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { readySnapshot, success } from "./fixtures";

beforeAll(() => {
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
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
});
async function setup(
  external = false,
  perform: (input: unknown) => unknown = () => success("container output"),
) {
  const app = await loadPluginApp(() => import("../app"));
  const state = structuredClone(readySnapshot);
  if (external) state.containers[0]!.managed = false;
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        hosts: () => ({ hosts: [{ id: "host-demo", name: "Demo Mac" }] }),
        snapshot: () => state,
        metrics: () => ({ sampledAt: Date.now(), containers: [] }),
        perform,
      },
    },
  );
  cleanup.push(() => slot.lifecycle.unmount());
  await slot.findByText("Container services running");
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
