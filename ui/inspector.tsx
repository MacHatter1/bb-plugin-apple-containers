import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  CommandResult,
  ContainerCommand,
  ContainerSummary,
  rpcContract,
} from "../contract";
import { parseCommand } from "../lib/argv";
import { errorMessage, type Sample } from "./use-runtime";
import { formatBytes, publishedPort, StateBadge, Symbol } from "./elements";
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
  const navigate = useBbNavigate();
  const ports = c.ports.map((port) => ({
    raw: port,
    parsed: publishedPort(port),
  }));
  const portLink = (parsed: NonNullable<ReturnType<typeof publishedPort>>) => (
    <a
      className="ac-port-link"
      href={parsed.url}
      title={`Open in your browser (container port ${parsed.guest}/${parsed.protocol})`}
      onClick={(event) => {
        event.preventDefault();
        navigate.openUrl(parsed.url);
      }}
    >
      {parsed.label}
      <Symbol name="external" size={12} />
    </a>
  );
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
        <div className="ac-detail-name">
          <h2>{c.id}</h2>
          <p>
            <span className="ac-mono" title={c.image}>
              {c.image}
            </span>
            <span
              className="ac-detail-project"
              title={
                c.project
                  ? `BB project: ${c.project.name}`
                  : "No BB project linked to this container"
              }
            >
              <Symbol name="projects" size={13} />
              <span>{c.project?.name ?? "No project"}</span>
            </span>
            {c.state === "running" &&
              ports[0]?.parsed &&
              portLink(ports[0].parsed)}
          </p>
        </div>
        <StateBadge state={c.state} />
      </header>
      <div className="ac-detail-actions">
        <button
          className={`ac-button ${c.state === "running" ? "" : "ac-button-primary"}`}
          disabled={busy || !canControl}
          onClick={() =>
            void act({ op: c.state === "running" ? "stop" : "start", id: c.id })
          }
        >
          <Symbol name={c.state === "running" ? "stop" : "play"} size={12} />
          {c.state === "running" ? "Stop" : "Start"}
        </button>
        <button
          className="ac-button ac-button-quiet ac-delete"
          aria-expanded={confirmDelete}
          disabled={busy || !canControl || c.state === "running"}
          title={
            c.state === "running" ? "Stop the container before deleting it" : ""
          }
          onClick={() => setConfirmDelete((v) => !v)}
        >
          Delete
        </button>
      </div>
      {!canControl && (
        <p className="ac-protected">
          <Symbol name="shield" size={14} />
          <span>
            Created outside BB. Controls are protected by the allowExternal
            setting.
          </span>
        </p>
      )}
      {confirmDelete && (
        <div className="ac-confirm" role="group" aria-label="Confirm delete">
          <p>
            Delete <strong className="ac-mono">{c.id}</strong> and its writable
            filesystem? Mounted folders and named volumes are kept.
          </p>
          <div>
            <button
              className="ac-button"
              onClick={() => setConfirmDelete(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              className="ac-button ac-button-danger"
              disabled={busy}
              onClick={() => void act({ op: "delete", id: c.id })}
            >
              Delete container
            </button>
          </div>
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
            <dl className="ac-spec">
              <div>
                <dt>Image</dt>
                <dd className="ac-mono">{c.image}</dd>
              </div>
              <div>
                <dt>CPUs</dt>
                <dd>{c.cpus}</dd>
              </div>
              <div>
                <dt>Memory limit</dt>
                <dd>{formatBytes(c.memoryBytes)}</dd>
              </div>
              <div>
                <dt>Processes</dt>
                <dd>{stats?.numProcesses ?? "—"}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>
                  {c.createdAt
                    ? new Date(c.createdAt).toLocaleString()
                    : "Unavailable"}
                </dd>
              </div>
              <div>
                <dt>Ownership</dt>
                <dd>{c.managed ? "Managed by BB" : "External container"}</dd>
              </div>
              <div>
                <dt>Addresses</dt>
                <dd>
                  {c.addresses.length
                    ? c.addresses.map((address) => (
                        <span key={address} className="ac-mono ac-spec-item">
                          {address}
                        </span>
                      ))
                    : "None"}
                </dd>
              </div>
              <div>
                <dt>Published ports</dt>
                <dd>
                  {ports.length
                    ? ports.map(({ raw, parsed }) => (
                        <span className="ac-spec-item" key={raw}>
                          {parsed ? (
                            <>
                              {c.state === "running" ? (
                                portLink(parsed)
                              ) : (
                                <span className="ac-mono">{parsed.label}</span>
                              )}
                              <span className="ac-spec-aside">
                                to container port {parsed.guest}/
                                {parsed.protocol}
                              </span>
                            </>
                          ) : (
                            <span className="ac-mono">{raw}</span>
                          )}
                        </span>
                      ))
                    : "None"}
                </dd>
              </div>
            </dl>
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
                  ? "Runs in the container, 60-second limit"
                  : view === "logs"
                    ? "Last 200 lines"
                    : "Configuration reported by the runtime"}
              </span>
              {view === "logs" && (
                <label>
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(e) => setFollow(e.target.checked)}
                  />
                  Refresh every 4 seconds
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
                  <Symbol name="arrow" size={16} />
                </button>
              </form>
            )}
            {loading && <p className="ac-output-note">Running…</p>}
          </>
        )}
      </div>
    </section>
  );
}
