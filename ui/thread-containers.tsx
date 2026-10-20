import { useCallback, useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import type { ThreadWorkspace } from "../lib/workspace-schema";
import { usePortalScopeProps } from "../lib/portal-scope";
import { Symbol } from "./elements";
import { errorMessage } from "./use-runtime";

type Operation = "ensure" | "stop";
const scopeNote =
  "App and development tools run in containers. Agent and Git run on the Mac.";

function presentation(
  workspace: ThreadWorkspace | null,
  error: string,
  operation: Operation | null,
) {
  const active =
    operation ??
    (workspace?.inspection.kind === "busy"
      ? workspace.inspection.operation
      : null);
  if (active)
    return {
      label:
        active === "teardown"
          ? "Cleaning up"
          : active === "stop"
            ? "Stopping"
            : "Starting",
      tone: "busy",
    };
  if (error || workspace?.inspection.kind === "unavailable")
    return { label: "Unavailable", tone: "error" };
  if (workspace?.inspection.kind === "checking")
    return { label: "Checking", tone: "busy" };
  if (workspace?.lastError) return { label: "Needs attention", tone: "error" };
  const state =
    workspace?.inspection.kind === "observed"
      ? workspace.inspection.state
      : null;
  if (!state?.configured) return { label: "Not started", tone: "neutral" };
  if (
    state.services.length &&
    state.services.every((s) => s.state === "running")
  )
    return { label: "Running", tone: "running" };
  if (
    state.services.length &&
    state.services.every((s) => s.state === "stopped")
  )
    return { label: "Stopped", tone: "neutral" };
  return { label: "Needs attention", tone: "error" };
}

function ThreadContainers({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const scope = usePortalScopeProps();
  const [workspace, setWorkspace] = useState<ThreadWorkspace | null>(null);
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null);
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<{ service: string; text: string } | null>(
    null,
  );
  const [readingLogs, setReadingLogs] = useState(false);
  const [notice, setNotice] = useState("");
  const alive = useRef(false),
    sequence = useRef(0),
    reading = useRef<number | null>(null),
    resolved = useRef(false),
    mutating = useRef(false),
    logSequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!alive.current || reading.current !== null || mutating.current) return;
    const request = ++sequence.current;
    reading.current = request;
    const accept = (value: ThreadWorkspace | null) => {
      if (!alive.current || sequence.current !== request) return false;
      resolved.current = value !== null;
      setWorkspace(value);
      setError("");
      return true;
    };
    try {
      const value = await rpc.call("threadWorkspace", {
        threadId,
        ...(!resolved.current ? { inspect: false } : {}),
      });
      if (!accept(value)) return;
      if (value?.inspection.kind === "checking")
        accept(await rpc.call("threadWorkspace", { threadId }));
    } catch (cause) {
      if (alive.current && sequence.current === request)
        setError(errorMessage(cause));
    } finally {
      if (reading.current === request) reading.current = null;
    }
  }, [rpc, threadId]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 8000);
    const onVisible = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      sequence.current++;
      reading.current = null;
      logSequence.current++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  useRealtime("workspaces-changed", () => {
    void refresh();
  });
  useRealtime("changed", () => {
    void refresh();
  });
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") void refresh();
  }, [connection, refresh]);
  async function act(next: Operation) {
    if (mutating.current) return;
    mutating.current = true;
    sequence.current++;
    reading.current = null;
    logSequence.current++;
    setReadingLogs(false);
    setLogs(null);
    setOperation(next);
    setError("");
    setNotice("");
    try {
      const value = await rpc.call("threadWorkspace", {
        threadId,
        action: next,
      });
      if (alive.current) {
        setWorkspace(value);
        setNotice(
          next === "stop"
            ? "Containers stopped. Persistent volumes are kept."
            : "Containers are running. Check app readiness before using its URL.",
        );
      }
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      mutating.current = false;
      if (alive.current) setOperation(null);
    }
  }
  async function readLogs(service: string) {
    const request = ++logSequence.current;
    setReadingLogs(true);
    setLogs({ service, text: "Loading logs…" });
    try {
      const result = await rpc.call("threadWorkspaceLogs", {
        threadId,
        service,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const text = `${output.length > 16_000 || result.truncated ? "Output clipped.\n" : ""}${output.slice(-16_000) || "No logs yet."}`;
      if (alive.current && logSequence.current === request)
        setLogs({ service, text });
    } catch (cause) {
      if (alive.current && logSequence.current === request)
        setLogs({ service, text: errorMessage(cause) });
    } finally {
      if (alive.current && logSequence.current === request)
        setReadingLogs(false);
    }
  }
  if (!workspace && !error) return null;
  const status = presentation(workspace, error, operation);
  const state =
    workspace && workspace.inspection.kind !== "unavailable"
      ? workspace.inspection.state
      : null;
  const busy = !!operation || workspace?.inspection.kind === "busy";
  const message =
    error ||
    (workspace?.inspection.kind === "unavailable"
      ? workspace.inspection.message
      : workspace?.lastError);
  const count = workspace?.services.length ?? 0;
  const unavailable = !!error || workspace?.inspection.kind === "unavailable";
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) void refresh();
      }}
    >
      <Popover.Trigger asChild>
        <button
          className="ac-thread-trigger"
          data-compact={isCompactViewport}
          data-tone={status.tone}
          aria-label={`Container status: ${status.label}${count ? `, ${count} ${count === 1 ? "container" : "containers"}` : ""}. Show details`}
          title={`${scopeNote} ${status.label}.`}
        >
          <Symbol name="cube" size={15} />
          {!isCompactViewport && <span>Containers</span>}
          <i className="ac-thread-dot" aria-hidden="true" />
          {!isCompactViewport && (
            <>
              <span>{status.label}</span>
              {count > 0 && <span className="ac-thread-count">{count}</span>}
              <Symbol name="chevron" size={10} />
            </>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...scope}
          className="ac-thread-popover"
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Container environment"
          data-tone={status.tone}
        >
          <div className="ac-thread-heading">
            <h2>Container environment</h2>
            <span className="ac-thread-status">
              <i className="ac-thread-dot" aria-hidden="true" />
              {status.label}
            </span>
          </div>
          {workspace && (
            <>
              <p className="ac-thread-workspace">
                {workspace.branchName || workspace.name} ·{" "}
                {workspace.isWorktree ? "Worktree" : "Project checkout"}
              </p>
              <p className="ac-thread-path" title={workspace.path}>
                {workspace.path}
              </p>
            </>
          )}
          {message && (
            <p className="ac-thread-message ac-thread-error" role="alert">
              {message}
            </p>
          )}
          {workspace && (
            <ul className="ac-thread-services">
              {workspace.services.map((definition) => {
                const service = state?.services.find(
                  (s) => s.name === definition.name,
                );
                const label =
                  definition.name === "app"
                    ? "App + development tools"
                    : definition.name;
                const serviceState = unavailable
                  ? "Unknown"
                  : (service?.state ?? (busy ? "Starting" : "Not started"));
                return (
                  <li key={definition.name}>
                    <div className="ac-thread-service-main">
                      <span className="ac-thread-service-icon">
                        <Symbol
                          name={definition.name === "app" ? "terminal" : "cube"}
                          size={16}
                        />
                      </span>
                      <span className="ac-thread-service-copy">
                        <strong>{label}</strong>
                        <small>{definition.image}</small>
                      </span>
                      <span
                        className="ac-thread-service-state"
                        data-running={serviceState === "running"}
                      >
                        {serviceState}
                      </span>
                      <button
                        className="ac-thread-icon"
                        aria-label={`View ${definition.name} logs`}
                        title="View logs"
                        disabled={
                          busy ||
                          readingLogs ||
                          !service ||
                          service.state === "missing" ||
                          unavailable ||
                          workspace.inspection.kind !== "observed"
                        }
                        onClick={() => void readLogs(definition.name)}
                      >
                        <Symbol name="logs" size={14} />
                      </button>
                    </div>
                    {!!service?.ports.length && (
                      <div className="ac-thread-ports">
                        {service.ports.map((port) =>
                          definition.name === "app" &&
                          service.state === "running" &&
                          workspace.inspection.kind === "observed" &&
                          !unavailable ? (
                            <a
                              key={port.guest}
                              href={`http://127.0.0.1:${port.host}`}
                              title={`Open app on the workspace Mac (container port ${port.guest})`}
                              onClick={(event) => {
                                event.preventDefault();
                                navigate.openUrl(
                                  `http://127.0.0.1:${port.host}`,
                                );
                              }}
                            >
                              localhost:{port.host}
                              <Symbol name="arrow" size={12} />
                            </a>
                          ) : (
                            <span key={port.guest}>
                              127.0.0.1:{port.host} → {port.guest}
                            </span>
                          ),
                        )}
                      </div>
                    )}
                    {!!service?.volumes.length && (
                      <small className="ac-thread-volume">
                        {service.volumes.length} persistent{" "}
                        {service.volumes.length === 1 ? "volume" : "volumes"}
                      </small>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {logs && (
            <section
              className="ac-thread-logs"
              aria-label={`${logs.service} logs`}
            >
              <div>
                <strong>{logs.service} logs</strong>
                <button
                  className="ac-thread-icon"
                  aria-label="Close logs"
                  onClick={() => {
                    logSequence.current++;
                    setReadingLogs(false);
                    setLogs(null);
                  }}
                >
                  <Symbol name="close" size={12} />
                </button>
              </div>
              <pre>{logs.text}</pre>
            </section>
          )}
          {notice && !message && (
            <p className="ac-thread-message" role="status">
              {notice}
            </p>
          )}
          <p className="ac-thread-note">{scopeNote}</p>
          <p className="ac-thread-note">
            Threads in this worktree share these containers. Ports are on its
            Mac.
          </p>
          <div className="ac-thread-actions">
            <button
              disabled={busy || !workspace?.enabled}
              onClick={() => void act("ensure")}
            >
              <Symbol name="play" size={13} />
              Start / reuse
            </button>
            <button
              disabled={busy || !state?.configured}
              onClick={() => void act("stop")}
            >
              <Symbol name="stop" size={12} />
              Stop
            </button>
          </div>
          <div className="ac-thread-footer">
            <button onClick={() => void refresh()} disabled={busy}>
              <Symbol name="refresh" size={12} />
              Refresh
            </button>
            {workspace && (
              <button
                onClick={() => {
                  setOpen(false);
                  navigate.toPluginPanel("dashboard", {
                    subPath: `projects/${workspace.projectId}/${workspace.environmentId}/${workspace.hostId}`,
                  });
                }}
              >
                Open dashboard
                <Symbol name="arrow" size={12} />
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ThreadContainerBadge(props: PluginThreadHeaderActionProps) {
  return <ThreadContainers key={props.threadId} {...props} />;
}
