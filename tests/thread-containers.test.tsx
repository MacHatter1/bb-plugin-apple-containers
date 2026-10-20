// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  configure,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  threadWorkspaceSchema,
  type ThreadWorkspace,
} from "../lib/workspace-schema";
import { success } from "./fixtures";
import { rpcContract } from "../contract";

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  // Strict Mode's simulated unmount releases the SDK harness's ownership guard.
  cleanup();
});
const running = threadWorkspaceSchema.parse({
  projectId: "project-a",
  environmentId: "env-feature",
  hostId: "mac-a",
  name: "feature",
  branchName: "feature",
  isWorktree: true,
  path: "/work/feature",
  enabled: true,
  services: [{ name: "app", image: "node:22" }],
  lastError: null,
  inspection: {
    kind: "observed",
    state: {
      environmentId: "env-feature",
      path: "/work/feature",
      configured: true,
      services: [
        {
          name: "app",
          id: "feature-app",
          state: "running",
          address: "192.168.1.2",
          ports: [{ guest: 3000, host: 42000 }],
          volumes: ["dependencies"],
        },
      ],
    },
  },
});
async function setup(
  read: (input: {
    threadId: string;
    action?: string;
    inspect?: boolean;
  }) => ThreadWorkspace | null | Promise<ThreadWorkspace | null> = () =>
    running,
  compact = false,
) {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    {
      threadId: "thread-a",
      projectId: "project-a",
      isCompactViewport: compact,
    },
    {
      rpc: {
        threadWorkspace: (input) =>
          read(rpcContract.threadWorkspace.input.parse(input)),
        threadWorkspaceLogs: () => success("actual app log"),
      },
    },
  );
  cleanups.push(() => slot.lifecycle.unmount());
  return slot;
}
it("shows live worktree details, app links and scoped logs without starting containers", async () => {
  const slot = await setup();
  fireEvent.click(
    await slot.findByRole("button", {
      name: "Container status: Running, 1 container. Show details",
    }),
  );
  await slot.findByRole("dialog", { name: "Container environment" });
  expect(slot.getByText("feature · Worktree")).toBeTruthy();
  expect(
    slot.getByRole("link", { name: "localhost:42000" }).getAttribute("href"),
  ).toBe("http://127.0.0.1:42000");
  expect(
    slot.inspection.rpcCalls
      .filter((c) => c.method === "threadWorkspace")
      .every((c) => !(c.input as { action?: string }).action),
  ).toBe(true);
  fireEvent.click(slot.getByRole("button", { name: "View app logs" }));
  await slot.findByText("actual app log");
  expect(slot.inspection.rpcCalls).toContainEqual(
    expect.objectContaining({
      method: "threadWorkspaceLogs",
      input: { threadId: "thread-a", service: "app" },
    }),
  );
  fireEvent.click(slot.getByRole("button", { name: "Open dashboard" }));
  expect(slot.inspection.navigateCalls).toContainEqual(
    expect.objectContaining({
      method: "toPluginPanel",
      path: "dashboard",
      options: { subPath: "projects/project-a/env-feature/mac-a" },
    }),
  );
});
it("keeps unconfigured threads unmarked and provides an accessible compact badge", async () => {
  const slot = await setup(() => null);
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0),
  );
  expect(slot.queryByRole("button")).toBeNull();
  slot.lifecycle.unmount();
  const compact = await setup(() => running, true);
  const badge = await compact.findByRole("button", {
    name: /Container status: Running/,
  });
  expect(badge.getAttribute("data-compact")).toBe("true");
  expect(badge.textContent).toBe("");
});
it("shows the badge on a Strict Mode effect remount without waiting for the polling timer", async () => {
  configure({ reactStrictMode: true });
  try {
    const slot = await setup();
    await slot.findByRole("button", { name: /Container status: Running/ });
  } finally {
    configure({ reactStrictMode: false });
  }
});
it("keeps a configured badge visible while the first host inspection is pending", async () => {
  let release!: (value: ThreadWorkspace) => void;
  const pending = new Promise<ThreadWorkspace>((resolve) => {
    release = resolve;
  });
  const slot = await setup((input) =>
    input.inspect === false
      ? { ...running, inspection: { kind: "checking", state: null } }
      : pending,
  );
  try {
    await slot.findByRole("button", { name: /Container status: Checking/ });
  } finally {
    await act(async () => release(running));
  }
  await slot.findByRole("button", { name: /Container status: Running/ });
});
it("shows startup while a shared operation is pending, then stops only the thread's workspace", async () => {
  let finish!: (value: ThreadWorkspace) => void;
  const pending = new Promise<ThreadWorkspace>((resolve) => {
    finish = resolve;
  });
  let current = running;
  const slot = await setup((input) =>
    input.action === "stop" ? pending : current,
  );
  fireEvent.click(
    await slot.findByRole("button", { name: /Container status: Running/ }),
  );
  fireEvent.click(await slot.findByRole("button", { name: "Stop" }));
  await slot.findByRole("button", { name: /Container status: Stopping/ });
  expect(
    (slot.getByRole("button", { name: "Start / reuse" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  const stopped = structuredClone(running);
  if (stopped.inspection.kind === "observed")
    stopped.inspection.state.services.forEach((s) => {
      s.state = "stopped";
    });
  current = stopped;
  await act(async () => finish(stopped));
  await slot.findByRole("button", { name: /Container status: Stopped/ });
  expect(slot.inspection.rpcCalls).toContainEqual(
    expect.objectContaining({
      method: "threadWorkspace",
      input: { threadId: "thread-a", action: "stop" },
    }),
  );
  current = {
    ...running,
    inspection: { kind: "busy", operation: "ensure", state: null },
  };
  await slot.behavior.emitRealtime("workspaces-changed", {
    environmentId: "env-feature",
  });
  await slot.findByRole("button", { name: /Container status: Starting/ });
});
it("reconciles after reconnect and replaces a green badge with unavailable on read failure", async () => {
  let offline = false;
  const slot = await setup(() => {
    if (offline) throw new Error("Workspace Mac offline");
    return running;
  });
  await slot.findByRole("button", { name: /Container status: Running/ });
  offline = true;
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  fireEvent.click(
    await slot.findByRole("button", { name: /Container status: Unavailable/ }),
  );
  await slot.findByRole("alert");
  expect(slot.getByRole("alert").textContent).toBe("Workspace Mac offline");
});
it("shows shared teardown as cleaning up and then not started", async () => {
  let current: ThreadWorkspace = {
    ...running,
    inspection: { kind: "busy", operation: "teardown", state: null },
  };
  const slot = await setup(() => current);
  await slot.findByRole("button", { name: /Container status: Cleaning up/ });
  current = {
    ...running,
    inspection: {
      kind: "observed",
      state: {
        environmentId: "env-feature",
        path: "/work/feature",
        configured: false,
        services: [],
      },
    },
  };
  await slot.behavior.emitRealtime("workspaces-changed", {
    environmentId: "env-feature",
  });
  await slot.findByRole("button", { name: /Container status: Not started/ });
});
