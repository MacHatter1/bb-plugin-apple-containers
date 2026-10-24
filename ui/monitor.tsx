import type { ContainerSummary } from "../contract";
import { Chart, formatBytes, niceBytes, niceCeiling } from "./elements";
import type { Sample } from "./use-runtime";

const sum = (items: number[]) => items.reduce((a, b) => a + b, 0);
/** Small multiples: one lane per resource, one ink, one shared time axis. */
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
  const running = containers.filter((c) => c.state === "running");
  const cpus = sum(running.map((c) => c.cpus));
  const memoryLimit = sum(running.map((c) => c.memoryBytes));
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
  const rate = (values: number[]) => `${formatBytes(values.at(-1) ?? 0)}/s`;
  const peak = (values: number[]) => Math.max(0, ...values);
  const cpuCeiling = Math.min(100, niceCeiling(Math.max(5, peak(cpu) * 1.2)));
  const rateCeiling = (values: number[]) =>
    niceBytes(Math.max(1024, peak(values) * 1.2));
  const lanes = [
    {
      name: "CPU",
      value: cpu.length ? `${cpu.at(-1)!.toFixed(1)}%` : "—",
      hint: `of ${cpus} ${cpus === 1 ? "vCPU" : "vCPUs"}`,
      series: cpu,
      ceiling: cpuCeiling,
      scale: `${cpuCeiling}%`,
    },
    {
      name: "Memory",
      value: latest
        ? formatBytes(sum(active.map((c) => c.memoryUsageBytes)))
        : "—",
      hint: `of ${formatBytes(memoryLimit)} allocated`,
      series: memory,
      ceiling: Math.max(memoryLimit, 1),
      scale: formatBytes(memoryLimit),
    },
    {
      name: "Network",
      value: latest ? rate(rx) : "—",
      hint: `received, ${rate(series("tx"))} sent`,
      series: rx,
      ceiling: rateCeiling(rx),
      scale: `${formatBytes(rateCeiling(rx))}/s`,
    },
    {
      name: "Disk",
      value: latest ? rate(read) : "—",
      hint: `read, ${rate(series("write"))} written`,
      series: read,
      ceiling: rateCeiling(read),
      scale: `${formatBytes(rateCeiling(read))}/s`,
    },
  ];
  return (
    <div className={`ac-lanes ${compact ? "ac-lanes-compact" : ""}`}>
      {lanes.map((lane) => (
        <section className="ac-lane" key={lane.name} aria-label={lane.name}>
          <h3>{lane.name}</h3>
          <div className="ac-lane-value">{lane.value}</div>
          <div className="ac-lane-hint">{lane.hint}</div>
          <Chart
            values={lane.series}
            ceiling={lane.ceiling}
            scale={lane.scale}
            label={`${lane.name} over the last five minutes`}
            idleMessage={
              running.length ? "Waiting for samples…" : "Not running"
            }
          />
        </section>
      ))}
      <p className="ac-lanes-axis" aria-hidden="true">
        <span>5 min ago</span>
        <span>Now</span>
      </p>
    </div>
  );
}
