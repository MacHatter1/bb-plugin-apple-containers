import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type {
  CommandResult,
  ContainerCommand,
  ContainerSummary,
  rpcContract,
} from "../contract";
import { parseCommand } from "../lib/argv";
import { errorMessage, type Sample } from "./use-runtime";
import { formatBytes, StateBadge, Symbol } from "./elements";
import { Monitor } from "./monitor";

export function Inspector({
  container: c,
  hostId,
  canControl,
  busy,
  act,
  samples,
}: {
  container: ContainerSummary;
  hostId: string;
  canControl: boolean;
  busy: boolean;
  act: (command: ContainerCommand) => Promise<boolean>;
  samples: Sample[];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState("overview"),
    [output, setOutput] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [commandRunning, setCommandRunning] = useState(false),
    [command, setCommand] = useState("uname -a"),
    [follow, setFollow] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const serial = useRef(0),
    executing = useRef(false),
    pendingReads = useRef(new Map<string, Promise<CommandResult>>());
  const read = useCallback(
    async (op: ContainerCommand) => {
      const isExec = op.op === "exec";
      if (isExec && executing.current) return;
      if (isExec) {
        executing.current = true;
        setCommandRunning(true);
      }
      const key = isExec ? null : JSON.stringify(op);
      const operation =
        (key ? pendingReads.current.get(key) : null) ??
        rpc.call("perform", { hostId, command: op });
      if (key) pendingReads.current.set(key, operation);
      const request = ++serial.current;
      setLoading(true);
      setError("");
      try {
        const result = await operation;
        if (request !== serial.current) return;
        let text = result.stdout;
        if (op.op === "inspect" && result.ok && !result.truncated) {
          try {
            text = JSON.stringify(JSON.parse(text), null, 2);
          } catch {
            /* Preserve native output. */
          }
        }
        const printed =
          [
            text,
            result.stderr,
            result.truncated ? "[Output clipped at 256 KiB]" : "",
          ]
            .filter(Boolean)
            .join("\n") || "No output.";
        setOutput((previous) =>
          op.op === "exec"
            ? `${previous ? previous + "\n\n" : ""}$ ${op.command.join(" ")}\n${printed}`.slice(
                -100_000,
              )
            : printed,
        );
        if (!result.ok) setError(`Command exited ${result.exitCode}.`);
      } catch (cause) {
        if (request === serial.current) setError(errorMessage(cause));
      } finally {
        if (key && pendingReads.current.get(key) === operation)
          pendingReads.current.delete(key);
        if (isExec) {
          executing.current = false;
          setCommandRunning(false);
        }
        if (request === serial.current) setLoading(false);
      }
    },
    [hostId, rpc],
  );
  useEffect(() => {
    setOutput("");
    setError("");
    setLoading(false);
    if (view === "logs") void read({ op: "logs", id: c.id, lines: 200 });
    if (view === "inspect") void read({ op: "inspect", id: c.id });
    return () => {
      serial.current++;
    };
  }, [view, c.id, read]);
  useEffect(() => {
    if (view !== "logs" || !follow) return;
    const timer = setInterval(
      () => void read({ op: "logs", id: c.id, lines: 200 }),
      4000,
    );
    return () => clearInterval(timer);
  }, [view, follow, read, c.id]);
  const stats = samples.at(-1)?.containers.find((item) => item.id === c.id);
  return (
    <section className="ac-inspector" aria-label={`Details for ${c.id}`}>
      <header className="ac-detail-header">
        <div
          className={`ac-resource-icon ${c.state === "running" ? "ac-icon-green" : ""}`}
        >
          <Symbol name="cube" size={24} />
        </div>
        <div className="ac-detail-name">
          <h2>{c.id}</h2>
          <p title={c.image}>{c.image}</p>
        </div>
        <StateBadge state={c.state} />
      </header>
      <div className="ac-detail-actions">
        <button
          className={`ac-button ${c.state === "running" ? "ac-button-stop" : "ac-button-primary"}`}
          disabled={busy || !canControl}
          onClick={() =>
            void act({ op: c.state === "running" ? "stop" : "start", id: c.id })
          }
        >
          <Symbol name={c.state === "running" ? "stop" : "play"} size={13} />
          {c.state === "running" ? "Stop" : "Start"}
        </button>
        <button
          className="ac-button"
          disabled={!canControl || c.state !== "running"}
          onClick={() => setView("console")}
        >
          <Symbol name="terminal" size={15} />
          Console
        </button>
        <button className="ac-button" onClick={() => setView("logs")}>
          <Symbol name="logs" size={15} />
          Logs
        </button>
        <button
          className="ac-button ac-delete"
          disabled={busy || !canControl || c.state === "running"}
          onClick={() => setConfirmDelete((v) => !v)}
        >
          Delete
        </button>
      </div>
      {!canControl && (
        <div className="ac-protected">
          <Symbol name="shield" size={15} />
          <span>
            Created outside BB. Controls are protected by the allowExternal
            setting.
          </span>
        </div>
      )}
      {confirmDelete && (
        <div className="ac-confirm">
          <p>
            Delete <strong>{c.id}</strong> and its writable filesystem? Mounted
            folders and named volumes remain.
          </p>
          <button
            className="ac-button ac-delete"
            disabled={busy}
            onClick={() => void act({ op: "delete", id: c.id })}
          >
            Delete container
          </button>
          <button
            className="ac-button"
            onClick={() => setConfirmDelete(false)}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      )}
      <nav className="ac-detail-tabs" aria-label="Container views">
        {["overview", "logs", "console", "inspect"].map((v) => (
          <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
            {v[0]!.toUpperCase()}
            {v.slice(1)}
          </button>
        ))}
      </nav>
      <div className="ac-detail-body">
        {view === "overview" ? (
          <>
            <Monitor containers={[c]} samples={samples} compact />
            <div className="ac-config">
              <h3>Configuration</h3>
              <dl>
                <dt>Image</dt>
                <dd>{c.image}</dd>
                <dt>CPUs</dt>
                <dd>
                  {c.cpus} {c.cpus === 1 ? "virtual CPU" : "virtual CPUs"}
                </dd>
                <dt>Memory limit</dt>
                <dd>{formatBytes(c.memoryBytes)}</dd>
                <dt>Created</dt>
                <dd>
                  {c.createdAt
                    ? new Date(c.createdAt).toLocaleString()
                    : "Unavailable"}
                </dd>
                <dt>Ownership</dt>
                <dd>{c.managed ? "Managed by BB" : "External container"}</dd>
                <dt>Processes</dt>
                <dd>{stats?.numProcesses ?? "—"}</dd>
              </dl>
            </div>
            <div className="ac-config">
              <h3>Networking</h3>
              <dl>
                <dt>Addresses</dt>
                <dd>
                  {c.addresses.length
                    ? c.addresses.map((address) => (
                        <div key={address} className="ac-mono">
                          {address}
                        </div>
                      ))
                    : "No active addresses"}
                </dd>
                <dt>Published ports</dt>
                <dd>
                  {c.ports.length
                    ? c.ports.map((port) => (
                        <span className="ac-port" key={port}>
                          {port}
                        </span>
                      ))
                    : "None"}
                </dd>
              </dl>
            </div>
          </>
        ) : (
          <>
            <div className="ac-output-toolbar">
              <span>
                <Symbol
                  name={view === "console" ? "terminal" : "logs"}
                  size={14}
                />
                {view === "console"
                  ? "Command console"
                  : view === "logs"
                    ? "Last 200 lines"
                    : "Container configuration"}
              </span>
              {view === "logs" && (
                <label>
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(e) => setFollow(e.target.checked)}
                  />
                  Auto-refresh
                </label>
              )}
              {view !== "console" && (
                <button
                  className="ac-icon-button"
                  aria-label={`Refresh ${view}`}
                  disabled={loading}
                  onClick={() =>
                    void read(
                      view === "logs"
                        ? { op: "logs", id: c.id, lines: 200 }
                        : { op: "inspect", id: c.id },
                    )
                  }
                >
                  <Symbol name="refresh" size={15} />
                </button>
              )}
            </div>
            {error && (
              <p role="alert" className="ac-error">
                {error}
              </p>
            )}
            <pre
              className={`ac-output ${view === "console" ? "ac-console-output" : ""}`}
            >
              {loading && !output
                ? "Loading…"
                : output ||
                  (view === "console"
                    ? "Run a command inside this container.\nFor a shell script, use: sh -lc 'your script'"
                    : "No output.")}
            </pre>
            {view === "console" && (
              <form
                className="ac-command-line"
                onSubmit={(e) => {
                  e.preventDefault();
                  try {
                    const args = parseCommand(command);
                    if (!args.length) throw new Error("Enter a command.");
                    void read({
                      op: "exec",
                      id: c.id,
                      command: args,
                      timeoutSeconds: 60,
                    });
                  } catch (cause) {
                    setError(errorMessage(cause));
                  }
                }}
              >
                <span>$</span>
                <input
                  aria-label="Guest command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Enter a command…"
                />
                <button
                  className="ac-icon-button"
                  aria-label="Run command"
                  disabled={
                    commandRunning ||
                    busy ||
                    !canControl ||
                    c.state !== "running"
                  }
                >
                  <Symbol name="arrow" size={17} />
                </button>
              </form>
            )}
            <p className="ac-output-note">
              {loading
                ? "Running…"
                : view === "console"
                  ? "Commands run in the container. Timeout: 60 seconds."
                  : view === "logs"
                    ? "Auto-refresh fetches a new tail every four seconds."
                    : "Raw configuration reported by Apple’s container runtime."}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
