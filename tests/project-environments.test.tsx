// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { readySnapshot } from "./fixtures";
import { workspaceProfileSchema } from "../lib/workspace-schema";

let app: Awaited<ReturnType<typeof loadPluginApp>>;
beforeAll(async () => {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
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
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
});
async function setup() {
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        hosts: () => ({ hosts: [{ id: "mac-a", name: "Demo Mac" }] }),
        snapshot: () => readySnapshot,
        metrics: () => ({ sampledAt: Date.now(), containers: [] }),
        workspaceProjects: () => [
          {
            id: "project-a",
            name: "Example project",
            profile: workspaceProfileSchema.parse({
              enabled: true,
              app: {
                name: "app",
                image: "alpine:3.23",
                command: ["sleep", "infinity"],
              },
            }),
          },
        ],
        workspaceEnvironments: () => [
          { id: "env-main", path: "/project", name: "main", isWorktree: false },
          {
            id: "env-feature",
            path: "/feature",
            name: "feature",
            isWorktree: true,
          },
        ],
        saveWorkspaceProfile: (input) =>
          (input as { profile: unknown }).profile,
        workspace: (input) => {
          const request = input as { environmentId: string; action: string };
          return {
            environmentId: request.environmentId,
            path: "/project",
            configured: request.action !== "status",
            services:
              request.action === "status"
                ? []
                : [
                    {
                      name: "app",
                      id: "test-app",
                      state: request.action === "stop" ? "stopped" : "running",
                      address: "192.168.1.2",
                      ports: [{ host: 42000, guest: 3000 }],
                      volumes: ["test-data"],
                    },
                  ],
          };
        },
      },
    },
  );
  cleanups.push(() => slot.lifecycle.unmount());
  await slot.findByText("Services running");
  fireEvent.click(
    within(
      slot.getByRole("navigation", { name: "Container dashboard sections" }),
    ).getByRole("button", { name: "Projects" }),
  );
  await slot.findByText("Example project");
  await slot.findByText("feature (worktree)");
  return slot;
}
it("saves a database preset with a secret-file reference and starts only the selected worktree", async () => {
  const slot = await setup();
  fireEvent.change(slot.getByLabelText("Database"), {
    target: { value: "mysql" },
  });
  await slot.findByLabelText("Database environment file");
  fireEvent.click(slot.getByRole("button", { name: "Save project setup" }));
  await slot.findByText("Project setup saved.");
  expect(slot.inspection.rpcCalls).toContainEqual(
    expect.objectContaining({
      method: "saveWorkspaceProfile",
      input: expect.objectContaining({
        profile: expect.objectContaining({
          services: [
            expect.objectContaining({
              name: "database",
              image: "mysql:8.4",
              envFile: ".env.containers.database",
              volumes: [{ name: "data", target: "/var/lib/mysql" }],
            }),
          ],
        }),
      }),
    }),
  );
  fireEvent.change(
    slot.getByRole("combobox", { name: "Checkout or worktree" }),
    { target: { value: "env-feature" } },
  );
  await slot.findByText("/feature");
  fireEvent.click(slot.getByRole("button", { name: "Start" }));
  await slot.findByText("127.0.0.1:42000 → 3000");
  expect(slot.inspection.rpcCalls).toContainEqual(
    expect.objectContaining({
      method: "workspace",
      input: { environmentId: "env-feature", action: "ensure" },
    }),
  );
});
it("requires an explicit replacement action before applying a changed recipe", async () => {
  const slot = await setup();
  fireEvent.click(slot.getByRole("button", { name: "Start" }));
  await slot.findByText("App and development tools");
  fireEvent.click(slot.getByRole("button", { name: "Apply saved setup" }));
  await slot.findByText("Apply saved setup?");
  expect(
    slot.inspection.rpcCalls.some(
      (c) =>
        c.method === "workspace" &&
        (c.input as { action: string }).action === "recreate",
    ),
  ).toBe(false);
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  expect(
    slot.inspection.rpcCalls.some(
      (c) =>
        c.method === "workspace" &&
        (c.input as { action: string }).action === "recreate",
    ),
  ).toBe(false);
});
