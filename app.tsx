import { useEffect, useState } from "react";
import {
  definePluginApp,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { ContainerSummary } from "./contract";
import { CreateDialog, ImageDialog } from "./ui/forms";
import {
  Empty,
  formatBytes,
  StateBadge,
  Symbol,
  type SymbolName,
} from "./ui/elements";
import { Inspector } from "./ui/inspector";
import { Monitor } from "./ui/monitor";
import { useMetrics, useRuntime } from "./ui/use-runtime";
import "./styles.css";
import "./ui/thread-containers.css";
import { ProjectEnvironments } from "./ui/project-environments";
import { ThreadContainerBadge } from "./ui/thread-containers";

type View =
  "dashboard" | "projects" | "containers" | "images" | "volumes" | "networks";
export function Dashboard({ subPath = "" }: PluginNavPanelProps) {
  const [routeView, routeProjectId, routeEnvironmentId, routeHostId] =
    subPath.split("/");
  const runtime = useRuntime();
  const {
    hosts,
    hostId,
    setHostId,
    data,
    busy,
    refreshing,
    refresh,
    act,
    error,
    notice,
  } = runtime;
  const [view, setView] = useState<View>(
      routeView === "projects" ? "projects" : "dashboard",
    ),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [selected, setSelected] = useState<string | null>(null),
    [creating, setCreating] = useState(false),
    [runImage, setRunImage] = useState<string | undefined>(),
    [imageDialog, setImageDialog] = useState<"pull" | "build" | null>(null);
  useEffect(() => {
    if (routeView === "projects") {
      setView("projects");
      if (hosts.some((host) => host.id === routeHostId)) setHostId(routeHostId);
    }
  }, [routeView, routeHostId, hosts, setHostId]);
  const running = data?.containers.filter((c) => c.state === "running") ?? [];
  const telemetry = useMetrics(hostId, !!data?.running && running.length > 0);
  useEffect(() => {
    setSelected(null);
    setCreating(false);
    setImageDialog(null);
    setQuery("");
  }, [hostId]);
  const chosen =
    data?.containers.find((c) => c.id === selected) ??
    (view === "containers" ? (running[0] ?? data?.containers[0]) : undefined);
  const filtered =
    data?.containers.filter(
      (c) =>
        `${c.id} ${c.image}`.toLowerCase().includes(query.toLowerCase()) &&
        (filter === "all" ||
          (filter === "managed" ? c.managed : c.state === filter)),
    ) ?? [];
  const nav: { id: View; label: string; icon: SymbolName; count?: number }[] = [
    { id: "dashboard", label: "Dashboard", icon: "dashboard" },
    { id: "projects", label: "Project environments", icon: "build" },
    {
      id: "containers",
      label: "Containers",
      icon: "cube",
      count: data?.containers.length,
    },
    {
      id: "images",
      label: "Images",
      icon: "images",
      count: data?.images.length,
    },
    {
      id: "volumes",
      label: "Volumes",
      icon: "volume",
      count: data?.volumes.length,
    },
    {
      id: "networks",
      label: "Networks",
      icon: "network",
      count: data?.networks.length,
    },
  ];
  function openContainer(c: ContainerSummary) {
    setSelected(c.id);
    setView("containers");
  }
  function newContainer(image?: string) {
    setRunImage(image);
    setCreating(true);
  }
  function row(c: ContainerSummary) {
    const sample = telemetry.samples.at(-1),
      metric = sample?.containers.find((v) => v.id === c.id),
      cpu = sample?.cpu[c.id];
    return (
      <div
        className={`ac-container-row ${chosen?.id === c.id && view === "containers" ? "is-selected" : ""}`}
        key={c.id}
      >
        <button
          className="ac-container-select"
          aria-label={`Open ${c.id}`}
          onClick={() => openContainer(c)}
        >
          <span
            className={`ac-resource-icon ${c.state === "running" ? "ac-icon-green" : ""}`}
          >
            <Symbol name="cube" size={22} />
          </span>
          <span className="ac-container-label">
            <strong>
              {c.id}
              {c.managed && <span className="ac-tag">BB</span>}
            </strong>
            <small title={c.image}>
              {c.image.replace(/^docker.io\/library\//, "")}
            </small>
          </span>
        </button>
        <div className="ac-row-metrics">
          <span>
            <small>CPU</small>
            {cpu != null ? `${(cpu / Math.max(1, c.cpus)).toFixed(1)}%` : "—"}
          </span>
          <span>
            <small>Memory</small>
            {metric
              ? formatBytes(metric.memoryUsageBytes)
              : c.state === "running"
                ? "—"
                : "Stopped"}
          </span>
        </div>
        <StateBadge state={c.state} />
        <button
          className="ac-icon-button ac-row-control"
          aria-label={`${c.state === "running" ? "Stop" : "Start"} ${c.id}`}
          disabled={busy || !(c.managed || data?.allowExternal)}
          onClick={() =>
            void act({ op: c.state === "running" ? "stop" : "start", id: c.id })
          }
        >
          <Symbol name={c.state === "running" ? "stop" : "play"} size={15} />
        </button>
      </div>
    );
  }
  const title = nav.find((n) => n.id === view)!.label;
  return (
    <div className="ac-shell">
      <div className="ac-workspace">
        <aside className="ac-sidebar" aria-label="Apple Containers navigation">
          <div className="ac-brand">
            <span className="ac-brand-icon">
              <Symbol name="cube" size={22} />
            </span>
            <span>
              Apple Containers<small>Local workspace</small>
            </span>
          </div>
          <nav aria-label="Container dashboard sections">
            <span className="ac-nav-label">Overview</span>
            {nav.slice(0, 1).map((n) => (
              <button
                key={n.id}
                aria-label={n.label}
                title={n.label}
                data-view={n.id}
                aria-pressed={view === n.id}
                onClick={() => setView(n.id)}
              >
                <Symbol name={n.icon} />
                <span>{n.label}</span>
              </button>
            ))}
            <span className="ac-nav-label">Resources</span>
            {nav.slice(1).map((n) => (
              <button
                key={n.id}
                aria-label={n.label}
                title={n.label}
                data-view={n.id}
                aria-pressed={view === n.id}
                onClick={() => {
                  setView(n.id);
                  setQuery("");
                }}
              >
                <Symbol name={n.icon} />
                <span>{n.id === "projects" ? "Projects" : n.label}</span>
                {n.count !== undefined && <small>{n.count}</small>}
              </button>
            ))}
          </nav>
          <div className="ac-sidebar-bottom">
            <div className="ac-engine">
              <i className={data?.running ? "is-running" : ""} />
              <span>
                {data?.running
                  ? "Services running"
                  : data
                    ? "Service offline"
                    : "Connecting…"}
                <small>Apple container runtime</small>
              </span>
            </div>
            <div className="ac-agent-note">
              <Symbol name="shield" size={14} />
              <span>Available to your agents</span>
            </div>
          </div>
        </aside>
        <main className="ac-main">
          <header className="ac-toolbar">
            <h1>{title}</h1>
            <div>
              <label className="ac-machine">
                <Symbol name="cpu" size={14} />
                <select
                  aria-label="Machine"
                  disabled={busy}
                  value={hostId}
                  onChange={(e) => setHostId(e.target.value)}
                >
                  {hosts.map((h) => (
                    <option value={h.id} key={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="ac-icon-button"
                aria-label="Refresh workspace"
                disabled={refreshing || !hostId}
                onClick={() => void refresh()}
              >
                <Symbol name="refresh" size={17} />
              </button>
              <button
                className="ac-button ac-button-primary"
                aria-label="New container"
                data-action="new-container"
                disabled={busy || !data?.running}
                onClick={() => newContainer()}
              >
                <Symbol name="plus" size={16} />
                <span>New container</span>
              </button>
            </div>
          </header>
          {(error || notice || busy) && (
            <div
              className={`ac-message ${error ? "ac-message-error" : ""}`}
              role={error ? "alert" : "status"}
            >
              <Symbol
                name={error ? "shield" : busy ? "refresh" : "check"}
                size={15}
              />
              {error || (busy ? "Working on your Mac…" : notice)}
            </div>
          )}
          <div
            className={`ac-body ${view === "containers" ? "ac-body-workbench" : ""}`}
          >
            {!data ? (
              <Empty
                title={
                  error
                    ? "Couldn’t connect to the runtime"
                    : "Connecting to your Mac"
                }
                icon="cpu"
                action={
                  <button className="ac-button" onClick={() => void refresh()}>
                    Refresh
                  </button>
                }
              >
                {error
                  ? "Check your machine connection, then try again."
                  : "Checking Apple container services and local resources…"}
              </Empty>
            ) : (
              <>
                {!data.running && (
                  <section className="ac-setup">
                    <span className="ac-runtime-symbol">
                      <Symbol name="cpu" size={26} />
                    </span>
                    <div>
                      <h2>
                        {data.installed
                          ? "Your container service is stopped"
                          : "Set up Apple containers"}
                      </h2>
                      <p>{data.message}</p>
                      {data.supported && data.installed ? (
                        <button
                          className="ac-button ac-button-primary"
                          disabled={busy}
                          onClick={() => void act({ op: "system-start" })}
                        >
                          Start service
                        </button>
                      ) : (
                        <a
                          href="https://github.com/apple/container"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Installation guide
                        </a>
                      )}
                    </div>
                  </section>
                )}
                {data.warnings.map((w) => (
                  <p key={w} className="ac-warning">
                    {w}
                  </p>
                ))}
                {view === "projects" && (
                  <ProjectEnvironments
                    key={hostId}
                    hostId={hostId}
                    initialProjectId={
                      routeView === "projects" ? routeProjectId : undefined
                    }
                    initialEnvironmentId={
                      routeView === "projects" ? routeEnvironmentId : undefined
                    }
                  />
                )}
                {view === "dashboard" && (
                  <div className="ac-dashboard">
                    <section className="ac-service-banner">
                      <span
                        className={`ac-service-check ${data.running ? "is-online" : ""}`}
                      >
                        <Symbol
                          name={data.running ? "check" : "cpu"}
                          size={24}
                        />
                      </span>
                      <div>
                        <h2>
                          {data.running
                            ? "Container services running"
                            : "Container service offline"}
                        </h2>
                        <p>
                          {data.version.replace(/ \(build:.*$/, "") ||
                            data.platform}
                        </p>
                      </div>
                      <span className="ac-chip">{data.platform}</span>
                      <span className="ac-live-label">
                        <i />
                        Live
                      </span>
                    </section>
                    <div className="ac-resource-strip">
                      {[
                        {
                          icon: "cube" as const,
                          label: "Containers",
                          value: data.containers.length,
                          detail: `${running.length} running`,
                          target: "containers" as const,
                          color: "green",
                        },
                        {
                          icon: "images" as const,
                          label: "Images",
                          value: data.images.length,
                          detail: "Ready to run",
                          target: "images" as const,
                          color: "blue",
                        },
                        {
                          icon: "volume" as const,
                          label: "Volumes",
                          value: data.volumes.length,
                          detail: "Persistent storage",
                          target: "volumes" as const,
                          color: "purple",
                        },
                        {
                          icon: "network" as const,
                          label: "Networks",
                          value: data.networks.length,
                          detail: "Local networks",
                          target: "networks" as const,
                          color: "teal",
                        },
                      ].map((item) => (
                        <button
                          key={item.label}
                          className="ac-resource-summary"
                          onClick={() => setView(item.target)}
                        >
                          <span className={`ac-summary-icon ac-${item.color}`}>
                            <Symbol name={item.icon} size={21} />
                          </span>
                          <span>
                            <small>{item.label}</small>
                            <strong>{item.value}</strong>
                            <em>{item.detail}</em>
                          </span>
                          <Symbol name="chevron" size={14} />
                        </button>
                      ))}
                    </div>
                    <div className="ac-section-heading">
                      <h2>Resource monitor</h2>
                      <span>
                        {running.length
                          ? "Live · sampled every 5 seconds"
                          : "No containers running"}
                      </span>
                    </div>
                    {telemetry.error && (
                      <p className="ac-warning">
                        Metrics unavailable: {telemetry.error}
                      </p>
                    )}
                    <Monitor
                      containers={data.containers}
                      samples={telemetry.samples}
                    />
                    <section className="ac-running-section">
                      <div className="ac-section-heading">
                        <h2>
                          Running containers
                          <span className="ac-count">{running.length}</span>
                        </h2>
                        <button
                          className="ac-text-button"
                          onClick={() => setView("containers")}
                        >
                          View all
                          <Symbol name="arrow" size={14} />
                        </button>
                      </div>
                      <div className="ac-row-list">
                        {running.length ? (
                          running.map(row)
                        ) : (
                          <Empty
                            title="Room for your next project"
                            icon="cube"
                            action={
                              <button
                                className="ac-button ac-button-primary"
                                disabled={!data.running || busy}
                                onClick={() => newContainer()}
                              >
                                <Symbol name="plus" size={15} />
                                New container
                              </button>
                            }
                          >
                            Start a Linux workspace, run a service, or let an
                            agent build in a container.
                          </Empty>
                        )}
                      </div>
                    </section>
                    <div className="ac-dashboard-footer">
                      <Symbol name="shield" size={15} />
                      <p>
                        Containers created here are labelled and ready for your
                        BB agents.
                      </p>
                      <span>
                        Updated {new Date(data.checkedAt).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                )}
                {view === "containers" && (
                  <div className="ac-workbench">
                    <section className="ac-container-browser">
                      <div className="ac-browser-tools">
                        <label className="ac-search">
                          <Symbol name="search" size={15} />
                          <input
                            aria-label="Filter containers"
                            placeholder="Search containers"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                          />
                        </label>
                        <div
                          className="ac-filter"
                          aria-label="Container filter"
                        >
                          {["all", "running", "stopped", "managed"].map((v) => (
                            <button
                              key={v}
                              aria-pressed={filter === v}
                              onClick={() => setFilter(v)}
                            >
                              {v === "managed"
                                ? "BB"
                                : v[0]!.toUpperCase() + v.slice(1)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="ac-browser-count">
                        {filtered.length}{" "}
                        {filtered.length === 1 ? "container" : "containers"}
                        <span>{running.length} running</span>
                      </div>
                      <div className="ac-browser-list">
                        {filtered.length ? (
                          filtered.map(row)
                        ) : (
                          <Empty
                            title={
                              query
                                ? "No matching containers"
                                : "No containers here"
                            }
                          >
                            {query
                              ? "Try another name or image."
                              : "Create a container to get started."}
                          </Empty>
                        )}
                      </div>
                    </section>
                    {chosen ? (
                      <Inspector
                        key={`${hostId}:${chosen.id}`}
                        container={chosen}
                        hostId={hostId}
                        canControl={chosen.managed || data.allowExternal}
                        busy={busy}
                        act={act}
                        samples={telemetry.samples}
                      />
                    ) : (
                      <Empty title="Select a container" icon="cube">
                        Its configuration, resource usage, logs and console
                        appear here.
                      </Empty>
                    )}
                  </div>
                )}
                {view === "images" && (
                  <div className="ac-inventory">
                    <div className="ac-view-heading">
                      <div>
                        <h2>Image library</h2>
                        <p>
                          {data.images.length} local{" "}
                          {data.images.length === 1 ? "image" : "images"} on
                          this Mac
                        </p>
                      </div>
                      <div className="ac-action-group">
                        <button
                          className="ac-button"
                          disabled={busy || !data.running}
                          onClick={() => setImageDialog("build")}
                        >
                          <Symbol name="build" size={15} />
                          Build image
                        </button>
                        <button
                          className="ac-button ac-button-primary"
                          disabled={busy || !data.running}
                          onClick={() => setImageDialog("pull")}
                        >
                          <Symbol name="plus" size={15} />
                          Pull image
                        </button>
                      </div>
                    </div>
                    <label className="ac-search ac-inventory-search">
                      <Symbol name="search" size={16} />
                      <input
                        aria-label="Filter images"
                        placeholder="Search images"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                    <div className="ac-image-list">
                      {data.images
                        .filter((i) =>
                          i.reference
                            .toLowerCase()
                            .includes(query.toLowerCase()),
                        )
                        .map((i) => (
                          <div
                            className="ac-image-row"
                            key={`${i.reference}:${i.digest}`}
                          >
                            <span className="ac-resource-icon ac-icon-blue">
                              <Symbol name="images" size={24} />
                            </span>
                            <div className="ac-image-name">
                              <strong>
                                {i.reference.replace(
                                  /^docker.io\/library\//,
                                  "",
                                )}
                              </strong>
                              <small title={i.digest}>{i.digest}</small>
                            </div>
                            <span className="ac-chip">OCI image</span>
                            <button
                              className="ac-button"
                              disabled={busy || !data.running}
                              onClick={() => newContainer(i.reference)}
                            >
                              <Symbol name="play" size={13} />
                              Run
                            </button>
                          </div>
                        ))}
                      {data.images.length === 0 && (
                        <Empty
                          title="Your image library starts here"
                          icon="images"
                          action={
                            <button
                              className="ac-button ac-button-primary"
                              disabled={busy || !data.running}
                              onClick={() => setImageDialog("pull")}
                            >
                              Pull your first image
                            </button>
                          }
                        >
                          Pull an OCI image from a registry, or build one from a
                          Dockerfile.
                        </Empty>
                      )}
                    </div>
                  </div>
                )}
                {(view === "networks" || view === "volumes") && (
                  <div className="ac-inventory">
                    <div className="ac-view-heading">
                      <div>
                        <h2>
                          {view === "networks"
                            ? "Container networks"
                            : "Persistent volumes"}
                        </h2>
                        <p>
                          {view === "networks"
                            ? "Networks available to your local containers."
                            : "Storage managed by Apple’s container runtime."}
                        </p>
                      </div>
                    </div>
                    <div className="ac-storage-grid">
                      {(view === "networks" ? data.networks : data.volumes).map(
                        (name) => (
                          <article className="ac-storage-card" key={name}>
                            <span
                              className={`ac-resource-icon ${view === "networks" ? "ac-icon-teal" : "ac-icon-purple"}`}
                            >
                              <Symbol
                                name={
                                  view === "networks" ? "network" : "volume"
                                }
                                size={26}
                              />
                            </span>
                            <h3>{name}</h3>
                            <span className="ac-chip">
                              {view === "networks"
                                ? name === "default"
                                  ? "Default network"
                                  : "Local network"
                                : "Named volume"}
                            </span>
                          </article>
                        ),
                      )}
                    </div>
                    {(view === "networks" ? data.networks : data.volumes)
                      .length === 0 && (
                      <Empty
                        title={
                          view === "networks"
                            ? "No networks reported"
                            : "No named volumes yet"
                        }
                        icon={view === "networks" ? "network" : "volume"}
                      >
                        {view === "networks"
                          ? "Networks will appear here when the runtime reports them."
                          : "Named volumes created with the container CLI will appear here."}
                      </Empty>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </main>
        {creating && (
          <CreateDialog
            key={runImage ?? "new"}
            open
            close={() => setCreating(false)}
            busy={busy}
            submit={act}
            image={runImage}
          />
        )}
        {imageDialog && (
          <ImageDialog
            mode={imageDialog}
            close={() => setImageDialog(null)}
            busy={busy}
            submit={act}
          />
        )}
      </div>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "containers",
    title: "Apple Containers",
    component: ThreadContainerBadge,
  });
  app.slots.navPanel({
    id: "dashboard",
    title: "Apple Containers",
    icon: "./assets/icon.svg",
    path: "dashboard",
    component: Dashboard,
  });
});
