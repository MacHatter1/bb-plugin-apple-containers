import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  experimental_usePluginId,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type {
  ContainerCommand,
  DiskResourceUsage,
  DiskUsage,
  ReclaimTarget,
  rpcContract,
} from "../contract";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { formatBytes, Symbol } from "./elements";

const targets: Record<
  ReclaimTarget,
  { title: string; description: string; action: string; global: boolean }
> = {
  "stopped-containers": {
    title: "Remove stopped BB containers?",
    description:
      "This deletes only stopped containers marked as managed by BB on the selected Mac. Their writable filesystems are removed. Named volumes and external containers are kept.",
    action: "Remove stopped containers",
    global: false,
  },
  "dangling-images": {
    title: "Remove dangling images?",
    description:
      "This removes untagged images from the selected Mac. They can be downloaded or rebuilt again. The cleanup can include images created outside BB.",
    action: "Remove dangling images",
    global: true,
  },
  "unused-images": {
    title: "Remove unused images?",
    description:
      "This removes images that no running or stopped container references on the selected Mac. They can be downloaded or rebuilt again. The cleanup can include images created outside BB.",
    action: "Remove unused images",
    global: true,
  },
  "unattached-volumes": {
    title: "Delete unattached volumes?",
    description:
      "This permanently deletes every volume with no container references on the selected Mac, including volumes created outside BB. Any data stored in those volumes is lost. Volumes attached to running or stopped containers are kept.",
    action: "Delete unattached volumes",
    global: true,
  },
};

function LedgerRow({
  title,
  description,
  usage,
  scale,
  note,
  warning = false,
  children,
}: {
  title: string;
  description: string;
  usage: DiskResourceUsage | null;
  scale: number;
  note: string;
  warning?: boolean;
  children: ReactNode;
}) {
  const share = usage && scale ? usage.sizeInBytes / scale : 0;
  const reclaimable =
    usage && usage.sizeInBytes ? usage.reclaimable / usage.sizeInBytes : 0;
  return (
    <section className="ac-ledger-row" aria-label={title}>
      <div className="ac-ledger-title">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="ac-ledger-usage">
        <div
          className="ac-ledger-bar"
          role="img"
          aria-label={
            usage
              ? `${formatBytes(usage.sizeInBytes)} on disk, ${formatBytes(usage.reclaimable)} reclaimable`
              : "Disk use unavailable"
          }
        >
          <span style={{ width: `${Math.min(1, share) * 100}%` }}>
            <span style={{ width: `${Math.min(1, reclaimable) * 100}%` }} />
          </span>
        </div>
        <dl className="ac-ledger-figures">
          <div>
            <dt>On disk</dt>
            <dd>{usage ? formatBytes(usage.sizeInBytes) : "—"}</dd>
          </div>
          <div>
            <dt>Reclaimable</dt>
            <dd>{usage ? formatBytes(usage.reclaimable) : "—"}</dd>
          </div>
          <div>
            <dt>In use</dt>
            <dd>{usage ? `${usage.active} of ${usage.total}` : "—"}</dd>
          </div>
        </dl>
        <p className={`ac-ledger-note ${warning ? "is-warning" : ""}`}>
          {note}
        </p>
      </div>
      <div className="ac-ledger-actions">{children}</div>
    </section>
  );
}

export function StorageView({
  hostId,
  allowExternal,
  running,
  hostName,
  busy,
  act,
  refresh,
}: {
  hostId: string;
  allowExternal: boolean;
  running: boolean;
  hostName: string;
  busy: boolean;
  act: (command: ContainerCommand) => Promise<boolean>;
  refresh: () => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const [diskUsage, setDiskUsage] = useState<DiskUsage | null>(null);
  const [usageError, setUsageError] = useState("");
  const [usageLoading, setUsageLoading] = useState(false);
  const request = useRef(0);
  const [target, setTarget] = useState<ReclaimTarget | null>(null);
  const [dataLossAcknowledged, setDataLossAcknowledged] = useState(false);
  const [enablingExternal, setEnablingExternal] = useState(false);
  const [permissionError, setPermissionError] = useState("");
  const selected = target ? targets[target] : null;
  const loadUsage = useCallback(async () => {
    if (!hostId || !running) return;
    const generation = ++request.current;
    setUsageLoading(true);
    setUsageError("");
    try {
      const value = await rpc.call("diskUsage", { hostId });
      if (generation === request.current) setDiskUsage(value);
    } catch (cause) {
      if (generation === request.current) {
        setDiskUsage(null);
        setUsageError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (generation === request.current) setUsageLoading(false);
    }
  }, [hostId, rpc, running]);
  useEffect(() => {
    setDiskUsage(null);
    setUsageError("");
    if (running) void loadUsage();
    else setUsageLoading(false);
    return () => {
      request.current++;
    };
  }, [loadUsage, running]);
  const close = () => {
    setTarget(null);
    setDataLossAcknowledged(false);
    setPermissionError("");
  };

  async function enableExternal() {
    setEnablingExternal(true);
    setPermissionError("");
    try {
      await sdk.plugins.updateSettings({
        pluginId,
        values: { allowExternal: true },
      });
      await refresh();
    } catch (cause) {
      setPermissionError(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setEnablingExternal(false);
    }
  }

  async function reclaim() {
    if (
      !target ||
      busy ||
      !running ||
      enablingExternal ||
      (selected?.global && !allowExternal) ||
      (target === "unattached-volumes" && !dataLossAcknowledged)
    )
      return;
    const current = target;
    const command: ContainerCommand = {
      op: "reclaim",
      target: current,
      confirmed: true,
      ...(current === "unattached-volumes"
        ? { dataLossAcknowledged: true as const }
        : {}),
    };
    close();
    if (await act(command)) await loadUsage();
  }

  const parts = diskUsage
    ? [diskUsage.containers, diskUsage.images, diskUsage.volumes]
    : [];
  const total = parts.reduce((sum, part) => sum + part.sizeInBytes, 0);
  const totalReclaimable = parts.reduce(
    (sum, part) => sum + part.reclaimable,
    0,
  );

  return (
    <div className="ac-page ac-storage">
      <div className="ac-lede-row">
        <p className="ac-lede">
          {diskUsage ? (
            <>
              Apple’s container runtime uses{" "}
              <strong>{formatBytes(total)}</strong> on {hostName}. About{" "}
              <strong>{formatBytes(totalReclaimable)}</strong> could be
              reclaimed. Figures are estimates and include resources created
              outside BB.
            </>
          ) : (
            <>Disk use by Apple’s container runtime on {hostName}.</>
          )}
        </p>
        <button
          className="ac-icon-button"
          aria-label="Refresh storage usage"
          title="Refresh"
          disabled={busy || usageLoading || !running}
          onClick={() => void loadUsage()}
        >
          <Symbol name="refresh" size={16} />
        </button>
      </div>

      {!running && (
        <p className="ac-callout">
          <Symbol name="storage" size={15} />
          <span>Start the Apple container service to see disk use.</span>
        </p>
      )}
      {running && !diskUsage && (
        <p className="ac-callout">
          <Symbol name="storage" size={15} />
          <span>
            {usageLoading
              ? "Reading disk use…"
              : usageError
                ? `Disk use is unavailable: ${usageError}`
                : "Disk use is unavailable. Check that the installed container CLI supports system df, then refresh."}
          </span>
        </p>
      )}
      {running && !allowExternal && (
        <p className="ac-callout">
          <Symbol name="shield" size={15} />
          <span>
            Image and volume cleanup can affect resources created outside BB, so
            it needs permission first. Choosing one of those actions explains
            what enabling it allows. Stopped BB containers can be removed
            without it.
          </span>
        </p>
      )}

      <div className="ac-ledger">
        <LedgerRow
          title="Container disks"
          description="Writable filesystems. Stopped containers keep theirs until removed."
          usage={diskUsage?.containers ?? null}
          scale={total}
          note="Covers every container. Cleanup removes only stopped containers created by BB; named volumes stay."
        >
          <button
            className="ac-button"
            disabled={busy || !running}
            onClick={() => setTarget("stopped-containers")}
          >
            Remove stopped BB containers
          </button>
        </LedgerRow>
        <LedgerRow
          title="Images"
          description="Layers cached for future container runs."
          usage={diskUsage?.images ?? null}
          scale={total}
          note="Images used by any container are kept. Removed images can be pulled or built again."
        >
          <button
            className="ac-button"
            disabled={busy || !running}
            onClick={() => setTarget("dangling-images")}
          >
            Remove dangling
          </button>
          <button
            className="ac-button"
            disabled={busy || !running}
            onClick={() => setTarget("unused-images")}
          >
            Remove all unused
          </button>
        </LedgerRow>
        <LedgerRow
          title="Volumes"
          description="Named volumes hold databases and dependency caches."
          usage={diskUsage?.volumes ?? null}
          scale={total}
          warning
          note="Deleting volumes permanently removes their data. Only volumes no container uses are eligible."
        >
          <button
            className="ac-button ac-button-danger"
            disabled={busy || !running}
            onClick={() => setTarget("unattached-volumes")}
          >
            Delete unattached volumes
          </button>
        </LedgerRow>
      </div>

      <Dialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !enablingExternal) close();
        }}
      >
        <DialogContent className="ac-dialog">
          <DialogHeader>
            <DialogTitle>{selected?.title}</DialogTitle>
            <DialogDescription>{selected?.description}</DialogDescription>
          </DialogHeader>
          {selected?.global && !allowExternal && (
            <p className="ac-space-authorization">
              Shared cleanup requires permission. Enabling access saves the
              external-control setting for this plugin and also permits control
              of containers created outside BB. You can turn it off in Apple
              Containers settings. Cleanup still needs a separate confirmation.
            </p>
          )}
          {permissionError && (
            <p className="ac-error ac-space-authorization" role="alert">
              {permissionError}
            </p>
          )}
          {target === "unattached-volumes" && (
            <label className="ac-space-acknowledge">
              <input
                type="checkbox"
                checked={dataLossAcknowledged}
                onChange={(event) =>
                  setDataLossAcknowledged(event.target.checked)
                }
              />
              I understand that data in unattached volumes will be permanently
              deleted.
            </label>
          )}
          <div className="ac-space-dialog-actions">
            <button
              className="ac-button"
              disabled={busy || enablingExternal}
              onClick={close}
            >
              Cancel
            </button>
            {selected?.global && !allowExternal ? (
              <button
                className="ac-button ac-button-primary"
                disabled={busy || !running || enablingExternal}
                onClick={() => void enableExternal()}
              >
                {enablingExternal
                  ? "Enabling access…"
                  : "Enable external control & cleanup"}
              </button>
            ) : (
              <button
                className={
                  target === "unattached-volumes"
                    ? "ac-button ac-button-danger"
                    : "ac-button ac-button-primary"
                }
                disabled={
                  busy ||
                  !running ||
                  enablingExternal ||
                  (target === "unattached-volumes" && !dataLossAcknowledged)
                }
                onClick={() => void reclaim()}
              >
                {selected?.action ?? "Reclaim"}
              </button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
