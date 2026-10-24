import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import {
  workspaceProfileSchema,
  type WorkspaceProfile,
  type WorkspaceState,
} from "../lib/workspace-schema";
import { formatCommand, parseCommand } from "../lib/argv";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Empty, Lamp, StateBadge, Symbol } from "./elements";
import { errorMessage } from "./use-runtime";
import {
  databasePreset,
  defaultWorkspaceProfile,
} from "../lib/workspace-presets";

type Project = { id: string; name: string; profile: WorkspaceProfile | null };
type Environment = {
  id: string;
  name: string;
  path: string;
  isWorktree: boolean;
};

function ProfileForm({
  profile,
  save,
  busy,
}: {
  profile: WorkspaceProfile | null;
  save: (profile: WorkspaceProfile) => Promise<void>;
  busy: boolean;
}) {
  const original = profile ?? defaultWorkspaceProfile();
  const [enabled, setEnabled] = useState(original.enabled);
  const [autoStart, setAutoStart] = useState(original.autoStart);
  const [image, setImage] = useState(original.app.image);
  const [command, setCommand] = useState(formatCommand(original.app.command));
  const [ports, setPorts] = useState(original.app.ports.join(", "));
  const [envFile, setEnvFile] = useState(original.app.envFile);
  const [cpus, setCpus] = useState(original.app.cpus);
  const [memory, setMemory] = useState(original.app.memoryMiB);
  const databaseService = original.services[0];
  const [database, setDatabase] = useState(
    original.services.length === 0
      ? "none"
      : original.services.length === 1 && databaseService?.name === "database"
        ? databaseService.image.startsWith("postgres:")
          ? "postgres"
          : databaseService.image.startsWith("mysql:")
            ? "mysql"
            : "custom"
        : "custom",
  );
  const [databaseEnv, setDatabaseEnv] = useState(
    databaseService?.envFile || ".env.containers.database",
  );
  const [services, setServices] = useState(
    JSON.stringify(original.services, null, 2),
  );
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const selectedServices: unknown =
        database === "none"
          ? []
          : database === "custom"
            ? JSON.parse(services)
            : [
                databaseService?.name === "database" &&
                databaseService.image.startsWith(`${database}:`)
                  ? { ...databaseService, envFile: databaseEnv }
                  : databasePreset(
                      database === "mysql" ? "mysql" : "postgres",
                      databaseEnv,
                    ),
              ];
      await save(
        workspaceProfileSchema.parse({
          enabled,
          autoStart,
          app: {
            ...original.app,
            image: image.trim(),
            command: parseCommand(command),
            envFile: envFile.trim(),
            ports: ports.trim()
              ? ports.split(",").map((v) => Number(v.trim()))
              : [],
            cpus,
            memoryMiB: memory,
          },
          services: selectedServices,
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <form
      className="ac-form ac-project-form"
      onSubmit={(event) => void submit(event)}
      aria-label="Project container setup"
    >
      <div className="ac-section-heading">
        <h2>Setup</h2>
        <span>Shared by every checkout and worktree</span>
      </div>
      <label className="ac-project-enable" data-on={enabled}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          aria-describedby="ac-project-enable-note"
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>
          <strong>Use containers for this project</strong>
          <small id="ac-project-enable-note">
            {enabled
              ? "Each checkout and worktree gets its own containers when an agent starts work."
              : "Off: agents run development commands directly on the Mac."}
          </small>
        </span>
      </label>
      <fieldset className="ac-fieldset">
        <legend>App container</legend>
        <div className="ac-form-row">
          <label>
            Development image
            <Input
              required
              className="ac-mono"
              value={image}
              disabled={busy}
              onChange={(e) => setImage(e.target.value)}
            />
            <small>
              An image with your project’s tools. You can build one in Images.
            </small>
          </label>
          <label>
            App ports
            <Input
              className="ac-mono"
              value={ports}
              disabled={busy}
              placeholder="3000, 8080"
              onChange={(e) => setPorts(e.target.value)}
            />
            <small>
              Ports inside the container. Each workspace gets its own Mac ports.
            </small>
          </label>
        </div>
        <label>
          Start command
          <Input
            className="ac-mono"
            value={command}
            disabled={busy}
            onChange={(e) => setCommand(e.target.value)}
          />
          <small>
            <code>sleep infinity</code> keeps a tools container open.{" "}
            <code>
              sh -lc 'npm ci &amp;&amp; npm run dev -- --hostname 0.0.0.0'
            </code>{" "}
            starts an app.
          </small>
        </label>
        <label>
          App environment file
          <Input
            className="ac-mono"
            value={envFile}
            disabled={busy}
            placeholder=".env.containers.app (optional)"
            onChange={(e) => setEnvFile(e.target.value)}
          />
          <small>
            Relative to each worktree. Only the file path is saved here.
          </small>
        </label>
      </fieldset>
      <fieldset className="ac-fieldset">
        <legend id="ac-database-legend">Database</legend>
        <div className="ac-form-row">
          <label>
            <select
              aria-labelledby="ac-database-legend"
              value={database}
              disabled={busy}
              onChange={(e) => setDatabase(e.target.value)}
            >
              <option value="none">No database</option>
              <option value="postgres">PostgreSQL 17</option>
              <option value="mysql">MySQL 8.4</option>
              <option value="custom">Custom services</option>
            </select>
          </label>
          {(database === "mysql" || database === "postgres") && (
            <label>
              Database environment file
              <Input
                required
                className="ac-mono"
                value={databaseEnv}
                disabled={busy}
                onChange={(e) => setDatabaseEnv(e.target.value)}
              />
            </label>
          )}
        </div>
        {(database === "mysql" || database === "postgres") && (
          <p className="ac-project-help">
            Create this ignored file in the workspace with{" "}
            {database === "mysql"
              ? "MYSQL_ROOT_PASSWORD and MYSQL_DATABASE"
              : "POSTGRES_PASSWORD and POSTGRES_DB"}
            . The app receives DATABASE_HOST and DATABASE_PORT. Add the file to
            .worktreeinclude if new worktrees need a copy.
          </p>
        )}
        {database === "custom" && (
          <label>
            Services (JSON)
            <textarea
              rows={12}
              value={services}
              disabled={busy}
              onChange={(e) => setServices(e.target.value)}
            />
            <small>
              Each service has a name, image, optional command, envFile, ports,
              and named volumes. Credentials stay in workspace files.
            </small>
          </label>
        )}
      </fieldset>
      <details className="ac-advanced">
        <summary>Resources and startup</summary>
        <div className="ac-form-row">
          <label>
            App CPUs
            <Input
              type="number"
              min={1}
              max={32}
              value={cpus}
              disabled={busy}
              onChange={(e) => setCpus(Number(e.target.value))}
            />
          </label>
          <label>
            App memory (MiB)
            <Input
              type="number"
              min={200}
              max={65536}
              value={memory}
              disabled={busy}
              onChange={(e) => setMemory(Number(e.target.value))}
            />
          </label>
        </div>
        <label className="ac-project-check">
          <input
            type="checkbox"
            checked={autoStart}
            disabled={busy}
            onChange={(e) => setAutoStart(e.target.checked)}
          />
          Start when an agent begins work
        </label>
      </details>
      {error && (
        <p role="alert" className="ac-error">
          {error}
        </p>
      )}
      <div className="ac-form-footer">
        <span>
          Changes apply to new workspaces. Existing ones keep their containers
          until you choose Apply saved setup.
        </span>
        <button
          className="ac-button ac-button-primary"
          type="submit"
          disabled={busy}
        >
          Save project setup
        </button>
      </div>
    </form>
  );
}

export function ProjectEnvironments({
  hostId,
  initialProjectId,
  initialEnvironmentId,
}: {
  hostId: string;
  initialProjectId?: string;
  initialEnvironmentId?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState("");
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState(false);
  const alive = useRef(true);
  const request = useRef(0);
  const mutation = useRef(false);
  useEffect(() => {
    alive.current = true;
    rpc.call("workspaceProjects").then(
      (values) => {
        if (!alive.current) return;
        setProjects(values);
        setProjectId(
          values.find((p) => p.id === initialProjectId)?.id ??
            values[0]?.id ??
            "",
        );
      },
      (cause) => {
        if (alive.current) setError(errorMessage(cause));
      },
    );
    return () => {
      alive.current = false;
      request.current++;
    };
  }, [rpc, initialProjectId]);
  useEffect(() => {
    let active = true;
    request.current++;
    setEnvironments([]);
    setEnvironmentId("");
    setState(null);
    setError("");
    setNotice("");
    if (projectId && hostId)
      rpc.call("workspaceEnvironments", { projectId, hostId }).then(
        (values) => {
          if (active) {
            setEnvironments(values);
            setEnvironmentId(
              values.find((e) => e.id === initialEnvironmentId)?.id ??
                values[0]?.id ??
                "",
            );
          }
        },
        (cause) => {
          if (active) setError(errorMessage(cause));
        },
      );
    return () => {
      active = false;
    };
  }, [rpc, projectId, hostId, initialEnvironmentId]);
  const selected = projects.find((p) => p.id === projectId);
  const currentEnvironment = environments.find((e) => e.id === environmentId);
  async function inspect() {
    if (!environmentId) return;
    const generation = ++request.current;
    try {
      const value = await rpc.call("workspace", {
        environmentId,
        action: "status",
      });
      if (alive.current && generation === request.current) {
        setState(value);
        setError("");
      }
    } catch (cause) {
      if (alive.current && generation === request.current)
        setError(errorMessage(cause));
    }
  }
  useEffect(() => {
    setState(null);
    setError("");
    void inspect();
    return () => {
      request.current++;
    };
  }, [environmentId, rpc]);
  useRealtime("workspaces-changed", () => {
    if (!mutation.current) void inspect();
  });
  async function action(operation: "ensure" | "stop" | "recreate") {
    if (mutation.current || !environmentId) return;
    mutation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const generation = ++request.current;
    try {
      const value = await rpc.call("workspace", {
        environmentId,
        action: operation,
      });
      if (alive.current && generation === request.current) {
        setState(value);
        setNotice(
          operation === "stop"
            ? "Containers stopped. Database volumes are kept."
            : "Containers are running. Check app and database readiness before testing.",
        );
      }
    } catch (cause) {
      if (alive.current && generation === request.current)
        setError(errorMessage(cause));
    } finally {
      mutation.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function save(profile: WorkspaceProfile) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await rpc.call("saveWorkspaceProfile", {
        projectId,
        profile,
      });
      if (alive.current) {
        setProjects((values) =>
          values.map((p) =>
            p.id === projectId ? { ...p, profile: saved } : p,
          ),
        );
        setNotice("Project setup saved.");
      }
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      mutation.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="ac-page ac-projects">
      <p className="ac-lede">
        Give each checkout and worktree its own app, database and tool
        containers, with separate ports and data. Threads working in the same
        checkout share them.
      </p>
      <label className="ac-project-picker">
        <span>Project</span>
        <select
          aria-label="Project"
          value={projectId}
          disabled={busy}
          onChange={(e) => setProjectId(e.target.value)}
        >
          {projects.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {selected && (
          <span className="ac-project-status">
            <Lamp state={selected.profile?.enabled ? "running" : "stopped"} />
            {selected.profile?.enabled
              ? "Containers on"
              : selected.profile
                ? "Containers off"
                : "Not set up"}
          </span>
        )}
      </label>
      {(error || notice || busy) && (
        <p
          className="ac-inline-notice"
          data-tone={error ? "error" : busy ? "busy" : "done"}
          role={error ? "alert" : "status"}
        >
          {error || (busy ? "Working on your project environment…" : notice)}
        </p>
      )}
      {!selected ? (
        <Empty icon="projects" title="No projects yet">
          Add a Git project in BB to give its checkouts and worktrees a
          container setup.
        </Empty>
      ) : (
        <div className="ac-projects-layout">
          <ProfileForm
            key={`${selected.id}:${JSON.stringify(selected.profile)}`}
            profile={selected.profile}
            busy={busy}
            save={save}
          />
          <section className="ac-project-runtime">
            <div className="ac-section-heading">
              <h2>Workspaces</h2>
              <span>On this Mac</span>
            </div>
            <label className="ac-project-picker">
              <span>Checkout or worktree</span>
              <select
                aria-label="Checkout or worktree"
                value={environmentId}
                disabled={busy}
                onChange={(e) => setEnvironmentId(e.target.value)}
              >
                {environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.isWorktree ? " (worktree)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {currentEnvironment && (
              <p className="ac-project-path ac-mono">
                {currentEnvironment.path}
              </p>
            )}
            {!environments.length ? (
              <p className="ac-project-help">
                No ready workspaces on this Mac. Open a thread in this project’s
                checkout or create a worktree first.
              </p>
            ) : (
              <>
                <div className="ac-project-actions">
                  <button
                    className="ac-button ac-button-primary"
                    disabled={busy || !selected.profile?.enabled}
                    onClick={() => void action("ensure")}
                  >
                    <Symbol name="play" size={12} />
                    Start
                  </button>
                  <button
                    className="ac-button"
                    disabled={
                      busy ||
                      !state?.services.some((s) =>
                        ["running", "stopping"].includes(s.state),
                      )
                    }
                    onClick={() => void action("stop")}
                  >
                    <Symbol name="stop" size={12} />
                    Stop
                  </button>
                  <button
                    className="ac-button"
                    disabled={
                      busy || !state?.configured || !selected.profile?.enabled
                    }
                    onClick={() => setConfirm(true)}
                  >
                    Apply saved setup
                  </button>
                  <button
                    className="ac-icon-button"
                    aria-label="Refresh project environment"
                    disabled={busy}
                    onClick={() => void inspect()}
                  >
                    <Symbol name="refresh" size={16} />
                  </button>
                </div>
                {!!state?.services.length && (
                  <ul className="ac-project-services">
                    {state.services.map((s) => (
                      <li className="ac-project-service" key={s.id}>
                        <div className="ac-project-service-name">
                          <strong>
                            {s.name === "app"
                              ? "App and development tools"
                              : s.name}
                          </strong>
                          <StateBadge state={s.state} />
                        </div>
                        <small className="ac-mono">{s.id}</small>
                        {(s.ports.length > 0 || s.volumes.length > 0) && (
                          <div className="ac-project-endpoints">
                            {s.ports.map((p) => (
                              <code key={p.guest}>
                                127.0.0.1:{p.host} → {p.guest}
                              </code>
                            ))}
                            {s.volumes.length > 0 && (
                              <small>
                                {s.volumes.length} persistent{" "}
                                {s.volumes.length === 1 ? "volume" : "volumes"}
                              </small>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {state && !state.configured && (
                  <p className="ac-project-help">
                    {selected.profile?.enabled
                      ? "No containers yet. Start creates them; other worktrees get their own when an agent begins work there."
                      : "Turn on Use containers for this project and save the setup to start workspaces."}
                  </p>
                )}
                <p className="ac-project-help">
                  The agent and Git run on the Mac. Development commands run in{" "}
                  <code>/workspace</code> inside the app container. Stopping
                  keeps volumes.
                </p>
              </>
            )}
          </section>
        </div>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="ac-dialog">
          <DialogHeader>
            <DialogTitle>Apply saved setup?</DialogTitle>
            <DialogDescription>
              This stops and replaces this workspace’s containers. Named
              database volumes are kept. Files stored only in a container’s root
              filesystem are removed. Other worktrees are unaffected.
            </DialogDescription>
          </DialogHeader>
          <div className="ac-dialog-actions">
            <button className="ac-button" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="ac-button ac-button-danger"
              onClick={() => {
                setConfirm(false);
                void action("recreate");
              }}
            >
              Replace containers
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
