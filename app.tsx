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
  Lamp,
  shortImage,
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
import { StorageView } from "./ui/storage";
import { groupByProject, Yard } from "./ui/yard";
import { Inventory } from "./ui/inventory";
import { Cleanup } from "./ui/cleanup";

type View =
  | "dashboard"
  | "projects"
  | "storage"
  | "containers"
  | "images"
  | "volumes"
  | "networks";
const cliVersion = (version: string) =>
  version.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
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
    noticeDetails,
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
  const hostName =
    hosts.find((host) => host.id === hostId)?.name ?? "the selected Mac";
  const canControl = (c: ContainerSummary) =>
    c.managed || !!data?.allowExternal;
  const toggle = (c: ContainerSummary) =>
    void act({ op: c.state === "running" ? "stop" : "start", id: c.id });
  const chosen =
    data?.containers.find((c) => c.id === selected) ??
    (view === "containers" ? (running[0] ?? data?.containers[0]) : undefined);
  const filtered =
    data?.containers.filter(
      (c) =>
        `${c.id} ${c.image} ${c.project?.name ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (filter === "all" ||
          (filter === "managed" ? c.managed : c.state === filter)),
    ) ?? [];
  const images =
    data?.images.filter((i) =>
      i.reference.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const nav: { id: View; label: string; icon: SymbolName; count?: number }[] = [
    { id: "dashboard", label: "Dashboard", icon: "dashboard" },
    { id: "projects", label: "Projects", icon: "projects" },
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
    { id: "storage", label: "Storage", icon: "storage" },
  ];
  function openContainer(c: ContainerSummary) {
    setSelected(c.id);
    setView("containers");
  }
  function newContainer(image?: string) {
    setRunImage(image);
    setCreating(true);
  }
  function navButton(n: (typeof nav)[number]) {
    return (
      <button
        key={n.id}
        aria-label={n.label}
        title={n.label}
        data-view={n.id}
        aria-current={view === n.id ? "page" : undefined}
        onClick={() => {
          setView(n.id);
          setQuery("");
        }}
      >
        <Symbol name={n.icon} size={17} />
        <span>{n.label}</span>
        {n.count !== undefined && <small>{n.count}</small>}
      </button>
    );
  }
  function row(c: ContainerSummary) {
    const isSelected = chosen?.id === c.id;
    return (
      <div className={`ac-row ${isSelected ? "is-selected" : ""}`} key={c.id}>
        <button
          className="ac-row-open"
          aria-label={`Open ${c.id}`}
          aria-current={isSelected ? "true" : undefined}
          onClick={() => openContainer(c)}
        >
          <Lamp state={c.state} />
          <span className="ac-row-text">
            <strong>{c.id}</strong>
            <small title={c.image}>{shortImage(c.image)}</small>
          </span>
        </button>
        <button
          className="ac-icon-button ac-row-control"
          aria-label={`${c.state === "running" ? "Stop" : "Start"} ${c.id}`}
          disabled={busy || !canControl(c)}
          onClick={() => toggle(c)}
        >
          <Symbol name={c.state === "running" ? "stop" : "play"} size={13} />
        </button>
      </div>
    );
  }
  const status = data?.running
    ? "Services running"
    : data
      ? data.installed
        ? "Service stopped"
        : "Not installed"
      : error
        ? "Not connected"
        : "Connecting…";
  const version = data && cliVersion(data.version);
  const title = nav.find((n) => n.id === view)!.label;
  return (
    <div className="ac-shell">
      <div className="ac-workspace">
        <aside className="ac-sidebar" aria-label="Apple Containers navigation">
          <div
            className="ac-runtime"
            data-state={data?.running ? "running" : data ? "stopped" : "idle"}
            title={data ? `${data.version} on ${data.platform}` : status}
          >
            <i aria-hidden="true" />
            <span>
              <strong>{status}</strong>
              <small>
                {data
                  ? version
                    ? `container CLI ${version}`
                    : data.platform
                  : hostName}
              </small>
            </span>
          </div>
          <nav aria-label="Container dashboard sections">
            {nav.slice(0, 2).map(navButton)}
            <span className="ac-nav-label">Runtime</span>
            {nav.slice(2).map(navButton)}
          </nav>
        </aside>
        <main className="ac-main">
          <header className="ac-toolbar">
            <h1>{title}</h1>
            <div className="ac-toolbar-actions">
              <label className="ac-machine" title="Machine">
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
                <Symbol
                  name="chevron"
                  size={10}
                  className="ac-machine-chevron"
                />
              </label>
              <button
                className="ac-icon-button"
                aria-label="Refresh workspace"
                title="Refresh"
                disabled={refreshing || !hostId}
                onClick={() => void refresh()}
              >
                <Symbol name="refresh" size={16} />
              </button>
              <button
                className="ac-button ac-button-primary"
                aria-label="New container"
                data-action="new-container"
                disabled={busy || !data?.running}
                onClick={() => newContainer()}
              >
                <Symbol name="plus" size={15} />
                <span>New container</span>
              </button>
            </div>
          </header>
          {(error || notice || busy) && (
            <div
              className="ac-message"
              data-tone={error ? "error" : busy ? "busy" : "done"}
            >
              <Symbol
                name={error ? "shield" : busy ? "refresh" : "check"}
                size={15}
              />
              <div className="ac-message-content">
                <div
                  className="ac-message-summary"
                  role={error ? "alert" : "status"}
                >
                  {error || (busy ? "Working on your Mac…" : notice)}
                </div>
                {!error && !busy && noticeDetails && (
                  <details className="ac-message-details">
                    <summary>View cleanup output</summary>
                    <pre>{noticeDetails}</pre>
                  </details>
                )}
              </div>
            </div>
          )}
          <div
            className={`ac-body ${view === "containers" ? "ac-body-workbench" : ""}`}
          >
            {!data ? (
              <Empty
                title={
                  error
                    ? "Couldn’t reach the container runtime"
                    : `Connecting to ${hostName}`
                }
                icon="cpu"
                action={
                  error ? (
                    <button
                      className="ac-button"
                      onClick={() => void refresh()}
                    >
                      Try again
                    </button>
                  ) : undefined
                }
              >
                {error
                  ? "Check that the machine is online in BB, then try again."
                  : "Checking Apple container services and local resources…"}
              </Empty>
            ) : (
              <>
                {!data.running && (
                  <section className="ac-setup">
                    <Symbol name="cpu" size={22} />
                    <div>
                      <h2>
                        {data.installed
                          ? "The container service is stopped"
                          : "Install Apple’s container runtime"}
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
                          Open the installation guide
                          <Symbol name="external" size={13} />
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
                {view === "storage" && (
                  <StorageView
                    hostId={hostId}
                    allowExternal={data.allowExternal}
                    running={data.running}
                    hostName={hostName}
                    busy={busy}
                    act={act}
                    refresh={refresh}
                  />
                )}
                {view === "dashboard" && (
                  <div className="ac-page ac-dashboard">
                    <section className="ac-section">
                      <div className="ac-section-heading">
                        <h2>Containers</h2>
                        <span>
                          {running.length} running,{" "}
                          {data.containers.length - running.length} stopped
                        </span>
                      </div>
                      {data.containers.length ? (
                        <Yard
                          containers={data.containers}
                          sample={telemetry.samples.at(-1)}
                          canControl={canControl}
                          busy={busy}
                          open={openContainer}
                          toggle={toggle}
                        />
                      ) : (
                        <Empty
                          title="No containers on this Mac"
                          icon="cube"
                          action={
                            <button
                              className="ac-button ac-button-primary"
                              disabled={!data.running || busy}
                              onClick={() => newContainer()}
                            >
                              <Symbol name="plus" size={15} />
                              Create a container
                            </button>
                          }
                        >
                          Start a Linux workspace or a service. Agents can use
                          containers created here.
                        </Empty>
                      )}
                    </section>
                    <section className="ac-section">
                      <div className="ac-section-heading">
                        <h2>Resource use</h2>
                        <span>
                          {running.length
                            ? `${plural(running.length, "running container")}, sampled every 5 seconds`
                            : "Nothing running"}
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
                    </section>
                    <Cleanup hostId={hostId} data={data} open={setView} />
                  </div>
                )}
                {view === "containers" && (
                  <div className="ac-workbench">
                    <section className="ac-container-browser">
                      <div className="ac-browser-tools">
                        <label className="ac-search">
                          <Symbol name="search" size={14} />
                          <input
                            aria-label="Filter containers"
                            placeholder="Name, image or project"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                          />
                        </label>
                        <div
                          className="ac-filter"
                          role="group"
                          aria-label="Container filter"
                        >
                          {["all", "running", "stopped", "managed"].map((v) => (
                            <button
                              key={v}
                              aria-pressed={filter === v}
                              title={
                                v === "managed"
                                  ? "Containers created by BB"
                                  : undefined
                              }
                              onClick={() => setFilter(v)}
                            >
                              {v === "managed"
                                ? "BB"
                                : v[0]!.toUpperCase() + v.slice(1)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="ac-browser-list">
                        {filtered.length ? (
                          groupByProject(filtered).map(
                            ({ project, containers }) => (
                              <section
                                className="ac-container-group"
                                aria-label={project?.name ?? "Other containers"}
                                key={project?.id ?? ""}
                              >
                                <div className="ac-container-group-heading">
                                  <h2 title={project?.name}>
                                    {project?.name ?? "Other containers"}
                                  </h2>
                                  <span className="ac-count">
                                    {containers.length}
                                  </span>
                                </div>
                                {containers.map(row)}
                              </section>
                            ),
                          )
                        ) : (
                          <Empty
                            title={
                              query
                                ? "No matching containers"
                                : "No containers here"
                            }
                          >
                            {query
                              ? "Try another name, image or project."
                              : filter === "all"
                                ? "Create a container to get started."
                                : "Choose All to see every container."}
                          </Empty>
                        )}
                      </div>
                    </section>
                    {chosen ? (
                      <Inspector
                        key={`${hostId}:${chosen.id}`}
                        container={chosen}
                        hostId={hostId}
                        canControl={canControl(chosen)}
                        busy={busy}
                        act={act}
                        samples={telemetry.samples}
                      />
                    ) : (
                      <Empty title="Select a container" icon="cube">
                        Its settings, resource use, logs and console appear
                        here.
                      </Empty>
                    )}
                  </div>
                )}
                {view === "images" && (
                  <div className="ac-page">
                    <div className="ac-lede-row">
                      <p className="ac-lede">
                        {plural(data.images.length, "image")} stored on{" "}
                        {hostName}. Run one to start a container from it.
                      </p>
                      <div className="ac-action-group">
                        <button
                          className="ac-button"
                          disabled={busy || !data.running}
                          onClick={() => setImageDialog("build")}
                        >
                          <Symbol name="build" size={14} />
                          Build image
                        </button>
                        <button
                          className="ac-button ac-button-primary"
                          disabled={busy || !data.running}
                          onClick={() => setImageDialog("pull")}
                        >
                          <Symbol name="plus" size={14} />
                          Pull image
                        </button>
                      </div>
                    </div>
                    {data.images.length > 0 && (
                      <label className="ac-search ac-page-search">
                        <Symbol name="search" size={14} />
                        <input
                          aria-label="Filter images"
                          placeholder="Filter images"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                    )}
                    {images.length > 0 && (
                      <ul className="ac-list">
                        {images.map((i) => (
                          <li
                            className="ac-list-row"
                            key={`${i.reference}:${i.digest}`}
                          >
                            <span className="ac-list-main">
                              <strong className="ac-mono">
                                {shortImage(i.reference)}
                              </strong>
                              <small className="ac-mono" title={i.digest}>
                                {i.digest}
                              </small>
                            </span>
                            {(() => {
                              const users = data.containers.filter(
                                (c) =>
                                  shortImage(c.image) ===
                                  shortImage(i.reference),
                              ).length;
                              return users ? (
                                <span
                                  className="ac-tag"
                                  title="Unused-image cleanup keeps images that containers use"
                                >
                                  Used by {plural(users, "container")}
                                </span>
                              ) : null;
                            })()}
                            <span className="ac-list-figure">
                              {i.size ? formatBytes(i.size) : ""}
                            </span>
                            <button
                              className="ac-button"
                              aria-label={`Run ${shortImage(i.reference)}`}
                              disabled={busy || !data.running}
                              onClick={() => newContainer(i.reference)}
                            >
                              <Symbol name="play" size={12} />
                              Run
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {data.images.length === 0 ? (
                      <Empty
                        title="No images yet"
                        icon="images"
                        action={
                          <button
                            className="ac-button ac-button-primary"
                            disabled={busy || !data.running}
                            onClick={() => setImageDialog("pull")}
                          >
                            Pull an image
                          </button>
                        }
                      >
                        Pull an OCI image from a registry, or build one from a
                        Dockerfile.
                      </Empty>
                    ) : (
                      images.length === 0 && (
                        <Empty title="No matching images" icon="images">
                          Try another name or tag.
                        </Empty>
                      )
                    )}
                  </div>
                )}
                {(view === "networks" || view === "volumes") && (
                  <Inventory
                    kind={view}
                    names={view === "networks" ? data.networks : data.volumes}
                    containers={data.containers}
                    workspaces={data.workspaces ?? {}}
                    hostName={hostName}
                  />
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
