import type { ContainerSummary } from "../contract";
import { Chart, formatBytes, Symbol } from "./elements";
import type { Sample } from "./use-runtime";

const sum = (items: number[]) => items.reduce((a, b) => a + b, 0);
export function Monitor({
  containers,
  samples,
  compact = false,
}: {
  containers: ContainerSummary[];
  samples: Sample[];
  compact?: boolean;
}) {
  const ids = new Set(containers.map((c) => c.id));
  const latest = samples.at(-1);
  const active = latest?.containers.filter((c) => ids.has(c.id)) ?? [];
  const cpus = sum(
    containers.filter((c) => c.state === "running").map((c) => c.cpus),
  );
  const memoryLimit = sum(
    containers.filter((c) => c.state === "running").map((c) => c.memoryBytes),
  );
  const series = (key: "cpu" | "rx" | "tx" | "read" | "write") =>
    samples
      .filter((s) => key !== "cpu" || [...ids].some((id) => s.cpu[id] != null))
      .map(
        (s) =>
          sum([...ids].map((id) => s[key][id] ?? 0)) /
          (key === "cpu" ? Math.max(1, cpus) : 1),
      );
  const cpu = series("cpu"),
    memory = samples.map((s) =>
      sum(
        s.containers
          .filter((c) => ids.has(c.id))
          .map((c) => c.memoryUsageBytes),
      ),
    );
  const rx = series("rx"),
    read = series("read");
  const memoryNow = sum(active.map((c) => c.memoryUsageBytes));
  const cards = [
    {
      name: "CPU",
      icon: "cpu" as const,
      color: "var(--ac-blue)",
      value: cpu.length ? `${cpu.at(-1)!.toFixed(1)}%` : "—",
      hint: `${cpus} ${cpus === 1 ? "vCPU" : "vCPUs"} allocated`,
      series: cpu,
      ceiling: 100,
      progress: cpu.at(-1) ?? 0,
    },
    {
      name: "Memory",
      icon: "memory" as const,
      color: "var(--ac-purple)",
      value: latest ? formatBytes(memoryNow) : "—",
      hint: `${formatBytes(memoryLimit)} allocated`,
      series: memory,
      ceiling: Math.max(memoryLimit, 1),
      progress: memoryLimit ? (memoryNow / memoryLimit) * 100 : 0,
    },
    {
      name: "Network",
      icon: "network" as const,
      color: "var(--ac-green)",
      value: latest ? `${formatBytes(rx.at(-1) ?? 0)}/s` : "—",
      hint: `Receive · ${formatBytes(series("tx").at(-1) ?? 0)}/s sent`,
      series: rx,
      ceiling: undefined,
      progress: undefined,
    },
    {
      name: "Disk I/O",
      icon: "volume" as const,
      color: "var(--ac-pink)",
      value: latest ? `${formatBytes(read.at(-1) ?? 0)}/s` : "—",
      hint: `Read · ${formatBytes(series("write").at(-1) ?? 0)}/s written`,
      series: read,
      ceiling: undefined,
      progress: undefined,
    },
  ];
  return (
    <div className={`ac-monitor ${compact ? "ac-monitor-compact" : ""}`}>
      {cards.map((card) => (
        <section className="ac-metric" key={card.name}>
          <div className="ac-metric-title">
            <Symbol name={card.icon} size={15} />
            <h3>{card.name}</h3>
            <i style={{ background: card.color }} />
          </div>
          <div className="ac-metric-number">{card.value}</div>
          <div className="ac-metric-hint">{card.hint}</div>
          {card.progress !== undefined && (
            <div className="ac-meter">
              <span
                style={{
                  width: `${Math.min(100, card.progress)}%`,
                  background: card.color,
                }}
              />
            </div>
          )}
          <Chart
            values={card.series}
            ceiling={card.ceiling}
            color={card.color}
            label={`${card.name} history from runtime samples`}
            idleMessage={
              containers.some((c) => c.state === "running")
                ? "Waiting for samples…"
                : "No running containers"
            }
          />
        </section>
      ))}
    </div>
  );
}
