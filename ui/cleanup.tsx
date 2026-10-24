import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Snapshot } from "../contract";
import { formatBytes, Symbol, type SymbolName } from "./elements";
import { unusedWorkspaceNames } from "./inventory";

type Target = "networks" | "volumes" | "storage";
const count = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** Things worth tidying on this Mac. Renders nothing when there are none. */
export function Cleanup({
  hostId,
  data,
  open,
}: {
  hostId: string;
  data: Snapshot;
  open: (target: Target) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [reclaimable, setReclaimable] = useState(0);
  useEffect(() => {
    let alive = true;
    setReclaimable(0);
    if (data.running)
      rpc.call("diskUsage", { hostId }).then(
        (usage) => {
          if (alive)
            setReclaimable(
              usage.images.reclaimable + usage.containers.reclaimable,
            );
        },
        () => {
          /* Storage explains disk-use failures; here the row just stays hidden. */
        },
      );
    return () => {
      alive = false;
    };
  }, [rpc, hostId, data.running]);
  const networks = unusedWorkspaceNames(data.networks, data.containers).length;
  const volumes = unusedWorkspaceNames(data.volumes, data.containers).length;
  const stopped = data.containers.filter(
    (c) => c.managed && c.state === "stopped",
  ).length;
  const items: {
    icon: SymbolName;
    text: string;
    action: string;
    target: Target;
  }[] = [
    ...(networks || volumes
      ? [
          {
            icon: "network" as const,
            text: `${[
              networks && count(networks, "workspace network"),
              volumes && count(volumes, "workspace volume"),
            ]
              .filter(Boolean)
              .join(
                " and ",
              )} ${networks + volumes === 1 ? "isn’t" : "aren’t"} used by any container.`,
            action: "Review",
            target: networks ? ("networks" as const) : ("volumes" as const),
          },
        ]
      : []),
    ...(stopped
      ? [
          {
            icon: "cube" as const,
            text: `${count(stopped, "stopped container")} created by BB still ${stopped === 1 ? "holds its" : "hold their"} filesystem.`,
            action: "Open Storage",
            target: "storage" as const,
          },
        ]
      : []),
    ...(reclaimable >= 1024 * 1024
      ? [
          {
            icon: "storage" as const,
            text: `About ${formatBytes(reclaimable)} of images and stopped containers could be reclaimed.`,
            action: "Open Storage",
            target: "storage" as const,
          },
        ]
      : []),
  ];
  if (!items.length) return null;
  return (
    <section className="ac-section">
      <div className="ac-section-heading">
        <h2>Cleanup</h2>
        <span>Nothing is removed without asking</span>
      </div>
      <ul className="ac-list ac-cleanup">
        {items.map((item) => (
          <li className="ac-list-row" key={item.text}>
            <Symbol name={item.icon} size={16} className="ac-list-icon" />
            <span className="ac-list-main">{item.text}</span>
            <button
              className="ac-button ac-button-quiet ac-cleanup-action"
              onClick={() => open(item.target)}
            >
              {item.action}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
