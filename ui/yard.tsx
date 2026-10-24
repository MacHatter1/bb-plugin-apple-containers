import type { ContainerSummary } from "../contract";
import {
  formatBytes,
  Lamp,
  publishedPort,
  shortImage,
  stateLabel,
  stateTone,
  Symbol,
} from "./elements";
import type { Sample } from "./use-runtime";

export type ProjectGroup = {
  project: ContainerSummary["project"];
  containers: ContainerSummary[];
};
/** Projects in name order, then containers that belong to no project. */
export function groupByProject(containers: ContainerSummary[]) {
  const groups = new Map<string, ProjectGroup>();
  for (const container of containers) {
    const key = container.project?.id ?? "";
    const group = groups.get(key);
    if (group) group.containers.push(container);
    else
      groups.set(key, { project: container.project, containers: [container] });
  }
  return [...groups.values()].sort((a, b) =>
    a.project && b.project
      ? a.project.name.localeCompare(b.project.name) ||
        a.project.id.localeCompare(b.project.id)
      : a.project
        ? -1
        : b.project
          ? 1
          : 0,
  );
}

/** Every container drawn as a box, parked in a bay for its project. A painted
 * box is running; bare steel is stopped. The door end starts and stops it. */
export function Yard({
  containers,
  sample,
  canControl,
  busy,
  open,
  toggle,
}: {
  containers: ContainerSummary[];
  sample: Sample | undefined;
  canControl: (container: ContainerSummary) => boolean;
  busy: boolean;
  open: (container: ContainerSummary) => void;
  toggle: (container: ContainerSummary) => void;
}) {
  const groups = groupByProject(containers);
  // A lone "Other containers" bay has nothing to be other than.
  const labelled = groups.length > 1 || !!groups[0]?.project;
  return (
    <div className="ac-yard">
      {groups.map(({ project, containers: boxes }) => {
        const name = project?.name ?? "Other containers";
        const running = boxes.filter((c) => c.state === "running").length;
        return (
          <section className="ac-bay" aria-label={name} key={project?.id ?? ""}>
            <header className="ac-bay-heading" hidden={!labelled}>
              <h3 title={name}>{name}</h3>
              <span>
                {running} of {boxes.length} running
              </span>
            </header>
            <ul className="ac-bay-boxes">
              {boxes.map((c) => {
                const metric = sample?.containers.find((v) => v.id === c.id);
                const cpu = sample?.cpu[c.id];
                const isRunning = c.state === "running";
                const action = isRunning ? "Stop" : "Start";
                const port = publishedPort(c.ports[0] ?? "");
                // The load line: memory in use against the container's limit.
                const load =
                  isRunning && metric && c.memoryBytes
                    ? Math.min(1, metric.memoryUsageBytes / c.memoryBytes)
                    : 0;
                return (
                  <li
                    className="ac-box"
                    data-tone={stateTone(c.state)}
                    key={c.id}
                  >
                    <button
                      className="ac-box-open"
                      aria-label={`Open ${c.id}`}
                      onClick={() => open(c)}
                    >
                      <span className="ac-box-state">
                        <Lamp state={c.state} />
                        {stateLabel(c.state)}
                        {port && (
                          <span
                            className="ac-box-port"
                            title={`Published on ${port.label}, container port ${port.guest}`}
                          >
                            {port.label}
                            {c.ports.length > 1 && ` +${c.ports.length - 1}`}
                          </span>
                        )}
                      </span>
                      <strong className="ac-box-name" title={c.id}>
                        {c.id}
                      </strong>
                      <span className="ac-box-image" title={c.image}>
                        {shortImage(c.image)}
                      </span>
                      {isRunning && (
                        <span className="ac-box-load">
                          <span>
                            {cpu != null
                              ? `${(cpu / Math.max(1, c.cpus)).toFixed(1)}%`
                              : "—"}{" "}
                            <small>CPU</small>
                          </span>
                          <span>
                            {metric
                              ? formatBytes(metric.memoryUsageBytes)
                              : "—"}{" "}
                            <small>of {formatBytes(c.memoryBytes)}</small>
                          </span>
                        </span>
                      )}
                      {load > 0 && (
                        <span
                          className="ac-box-loadline"
                          style={{ width: `${load * 100}%` }}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                    <button
                      className="ac-box-door"
                      aria-label={`${action} ${c.id}`}
                      title={
                        canControl(c)
                          ? `${action} container`
                          : "Created outside BB. Allow external control in settings to change it."
                      }
                      disabled={busy || !canControl(c)}
                      onClick={() => toggle(c)}
                    >
                      <Symbol name={isRunning ? "stop" : "play"} size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
