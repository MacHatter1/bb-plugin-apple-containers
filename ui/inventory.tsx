import type { ContainerSummary, Snapshot } from "../contract";
import { Empty, Symbol } from "./elements";

type Kind = "networks" | "volumes";
type Workspaces = NonNullable<Snapshot["workspaces"]>;
type Entry = { name: string; detail: string; tag?: string; unused?: boolean };
type Group = { key: string; title: string; note?: string; entries: Entry[] };

const UNKNOWN = "\u0000unknown";
const OTHER = "\u0000other";
/** Workspace networks are `bb-ws-<key>` and volumes `bb-ws-<key>-<service>-<volume>`,
 * where the key is the one stamped on that workspace's containers. */
const workspaceName = /^bb-ws-([0-9a-f]{24})(?:-(.+))?$/;

function group(
  kind: Kind,
  names: string[],
  containers: ContainerSummary[],
  workspaces: Workspaces,
) {
  const members = new Map<string, ContainerSummary[]>();
  for (const c of containers)
    if (c.workspaceKey)
      members.set(c.workspaceKey, [...(members.get(c.workspaceKey) ?? []), c]);
  const groups = new Map<string, Group>();
  const add = (key: string, title: string, entry: Entry) => {
    const g = groups.get(key) ?? { key, title, entries: [] };
    g.entries.push(entry);
    groups.set(key, g);
  };
  for (const name of names) {
    const match = workspaceName.exec(name);
    if (!match) {
      add(OTHER, "Other", {
        name,
        detail:
          name === "default"
            ? "Used by containers that don’t ask for a network"
            : kind === "networks"
              ? "Network"
              : "Named volume",
        ...(name === "default" ? { tag: "Default" } : {}),
      });
      continue;
    }
    const users = members.get(match[1]!) ?? [];
    const info = workspaces[match[1]!];
    const project =
      users.find((c) => c.project)?.project?.name ?? info?.project;
    const checkout = info
      ? `${info.environment === "Project checkout" ? "Project checkout" : `${info.environment} worktree`}${info.removed ? " (removed)" : ""}`
      : undefined;
    const entry: Entry = {
      name,
      detail:
        [kind === "volumes" ? match[2] : undefined, checkout]
          .filter(Boolean)
          .join(", ") ||
        (kind === "networks" ? "Workspace network" : "Workspace data"),
      tag: users.length
        ? `${users.length} ${users.length === 1 ? "container" : "containers"}`
        : "Unused",
      unused: !users.length,
    };
    if (project) add(`project:${project}`, project, entry);
    else add(UNKNOWN, "Unknown workspaces", entry);
  }
  const unknown = groups.get(UNKNOWN);
  if (unknown)
    unknown.note =
      "BB has no record of the checkout these belong to. They’re usually left by deleted projects.";
  return [...groups.values()].sort((a, b) => {
    const rank = (g: Group) =>
      g.key === OTHER ? 2 : g.key === UNKNOWN ? 1 : 0;
    return rank(a) - rank(b) || a.title.localeCompare(b.title);
  });
}

/** Networks or volumes, grouped by the project workspace that owns them. */
export function Inventory({
  kind,
  names,
  containers,
  workspaces,
  hostName,
}: {
  kind: Kind;
  names: string[];
  containers: ContainerSummary[];
  workspaces: Workspaces;
  hostName: string;
}) {
  const groups = group(kind, names, containers, workspaces);
  const unused = groups
    .flatMap((g) => g.entries)
    .filter((e) => e.unused).length;
  return (
    <div className="ac-page">
      <p className="ac-lede">
        {kind === "networks"
          ? `Networks on ${hostName}. Each project workspace gets a private network for its app and database.`
          : `Named volumes on ${hostName}. They keep data, such as databases, when containers are replaced.`}
        {unused > 0 &&
          (kind === "networks"
            ? ` ${unused} ${unused === 1 ? "isn’t" : "aren’t"} used by any container, usually because a worktree was removed.`
            : ` ${unused} ${unused === 1 ? "isn’t" : "aren’t"} attached to any container. They may still hold data, so they stay until you delete them in Storage.`)}
      </p>
      {names.length ? (
        <div className="ac-inventory">
          {groups.map((g) => (
            <section
              className="ac-inventory-group"
              aria-label={g.title}
              key={g.key}
            >
              <div className="ac-inventory-heading">
                <h2>{g.title}</h2>
                <span className="ac-count">{g.entries.length}</span>
              </div>
              {g.note && <p className="ac-inventory-note">{g.note}</p>}
              <ul className="ac-list">
                {g.entries.map((entry) => (
                  <li className="ac-list-row" key={entry.name}>
                    <Symbol
                      name={kind === "networks" ? "network" : "volume"}
                      size={16}
                      className="ac-list-icon"
                    />
                    <span className="ac-list-main">
                      <strong className="ac-mono">{entry.name}</strong>
                      <small>{entry.detail}</small>
                    </span>
                    {entry.tag && (
                      <span
                        className="ac-tag"
                        data-tone={entry.unused ? "unused" : undefined}
                      >
                        {entry.tag}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <Empty
          title={
            kind === "networks"
              ? "No networks reported"
              : "No named volumes yet"
          }
          icon={kind === "networks" ? "network" : "volume"}
        >
          {kind === "networks"
            ? "Networks appear here when the runtime reports them."
            : "Project databases and caches create volumes when they first start."}
        </Empty>
      )}
    </div>
  );
}

/** Workspace networks or volumes whose containers no longer exist. */
export function unusedWorkspaceNames(
  names: string[],
  containers: ContainerSummary[],
) {
  const keys = new Set(containers.flatMap((c) => c.workspaceKey ?? []));
  return names.filter((name) => {
    const key = workspaceName.exec(name)?.[1];
    return !!key && !keys.has(key);
  });
}
