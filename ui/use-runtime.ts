import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  ContainerCommand,
  Metrics,
  Snapshot,
  rpcContract,
} from "../contract";
export const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
export function useRuntime() {
  const rpc = useRpc<typeof rpcContract>();
  const [hosts, setHosts] = useState<{ id: string; name: string }[]>([]),
    [hostId, setHostId] = useState("");
  const [data, setData] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false);
  const activeHost = useRef(hostId),
    generation = useRef(0),
    inFlight = useRef<string | null>(null),
    mutation = useRef(false);
  activeHost.current = hostId;
  useEffect(() => {
    let alive = true;
    rpc.call("hosts").then(
      (value) => {
        if (alive) {
          setHosts(value.hosts);
          setHostId(value.hosts[0]?.id ?? "");
          if (!value.hosts.length)
            setError(
              "No machines available. Add a Mac in BB’s Machines settings.",
            );
        }
      },
      (cause) => {
        if (alive) setError(errorMessage(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, [rpc]);
  const refresh = useCallback(async () => {
    if (!hostId || inFlight.current === hostId) return;
    const request = ++generation.current;
    inFlight.current = hostId;
    setRefreshing(true);
    try {
      const value = await rpc.call("snapshot", { hostId });
      if (request === generation.current && activeHost.current === hostId) {
        setData(value);
        setError("");
      }
    } catch (cause) {
      if (request === generation.current && activeHost.current === hostId)
        setError(errorMessage(cause));
    } finally {
      if (inFlight.current === hostId) inFlight.current = null;
      if (request === generation.current) setRefreshing(false);
    }
  }, [rpc, hostId]);
  useEffect(() => {
    generation.current++;
    setData(null);
    setError("");
    setNotice("");
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 8000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  useRealtime("changed", () => {
    void refresh();
  });
  async function act(command: ContainerCommand): Promise<boolean> {
    if (mutation.current || !hostId) return false;
    const target = hostId;
    mutation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await rpc.call("perform", { hostId: target, command });
      if (activeHost.current !== target) return result.ok;
      if (!result.ok)
        throw new Error(
          result.stderr || result.stdout || `Command exited ${result.exitCode}`,
        );
      setNotice(
        command.op === "run"
          ? `Created ${command.name}.`
          : command.op === "pull"
            ? `Pulled ${command.image}.`
            : command.op === "delete"
              ? `Deleted ${command.id}.`
              : "Operation completed.",
      );
      await refresh();
      return true;
    } catch (cause) {
      if (activeHost.current === target) setError(errorMessage(cause));
      return false;
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  return {
    rpc,
    hosts,
    hostId,
    setHostId,
    data,
    error,
    notice,
    busy,
    refreshing,
    refresh,
    act,
  };
}
export type Sample = Metrics & {
  cpu: Record<string, number | null>;
  rx: Record<string, number>;
  tx: Record<string, number>;
  read: Record<string, number>;
  write: Record<string, number>;
};
export function calculateSample(next: Metrics, previous?: Metrics): Sample {
  const result: Sample = {
    ...next,
    cpu: {},
    rx: {},
    tx: {},
    read: {},
    write: {},
  };
  const seconds = previous ? (next.sampledAt - previous.sampledAt) / 1000 : 0;
  for (const item of next.containers) {
    const old = previous?.containers.find((p) => p.id === item.id);
    const valid = !!old && seconds > 0 && item.cpuUsageUsec >= old.cpuUsageUsec;
    result.cpu[item.id] = valid
      ? ((item.cpuUsageUsec - old.cpuUsageUsec) / (seconds * 1_000_000)) * 100
      : null;
    for (const [key, counter] of [
      ["rx", "networkRxBytes"],
      ["tx", "networkTxBytes"],
      ["read", "blockReadBytes"],
      ["write", "blockWriteBytes"],
    ] as const) {
      result[key][item.id] = valid
        ? Math.max(0, item[counter] - old[counter]) / seconds
        : 0;
    }
  }
  return result;
}
export function useMetrics(hostId: string, enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [samples, setSamples] = useState<Sample[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    setSamples([]);
    setError("");
    if (!hostId || !enabled) return;
    let alive = true,
      fetching = false;
    let previous: Metrics | undefined;
    const poll = async () => {
      if (fetching || !alive || document.visibilityState === "hidden") return;
      fetching = true;
      try {
        const value = await rpc.call("metrics", { hostId });
        if (alive) {
          const sample = calculateSample(value, previous);
          previous = value;
          setSamples((v) => [...v.slice(-59), sample]);
          setError("");
        }
      } catch (cause) {
        if (alive) setError(errorMessage(cause));
      } finally {
        fetching = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [rpc, hostId, enabled]);
  return { samples, error };
}
