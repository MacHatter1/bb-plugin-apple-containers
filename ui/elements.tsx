import type { ReactNode } from "react";
export type SymbolName =
  | "cube"
  | "dashboard"
  | "projects"
  | "storage"
  | "images"
  | "volume"
  | "network"
  | "cpu"
  | "memory"
  | "terminal"
  | "logs"
  | "plus"
  | "refresh"
  | "play"
  | "stop"
  | "close"
  | "search"
  | "check"
  | "chevron"
  | "shield"
  | "arrow"
  | "external"
  | "build";
const paths: Record<SymbolName, ReactNode> = {
  cube: (
    <>
      <path d="m12 3 9 4.5v9L12 21l-9-4.5v-9zM3 7.5l9 4.5 9-4.5M12 12v9M7.5 5.3l9 4.5" />
    </>
  ),
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  projects: (
    <>
      <path d="M3.5 7.5V6a2 2 0 0 1 2-2h4l2 2h6.75a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" />
      <path d="m10 12.5-1.5 1.5L10 15.5m4-3 1.5 1.5-1.5 1.5m-2.25-2.5-1.5 3" />
    </>
  ),
  storage: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M3 14h18m-13.5 3h.01m3.49 0h.01" />
    </>
  ),
  images: (
    <>
      <path d="m12 3 10 5-10 5L2 8zM3 12l9 4.5 9-4.5M3 16l9 4.5 9-4.5" />
    </>
  ),
  volume: (
    <>
      <path d="m6 4-3 10v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5L18 4zM3 14h18M16 17h2" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18M5 6.5h14M5 17.5h14" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </>
  ),
  memory: (
    <>
      <rect x="3" y="6" width="18" height="11" rx="2" />
      <path d="M6 17v3m4-3v3m4-3v3m4-3v3M7 9v5m5-5v5m5-5v5" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  ),
  logs: (
    <>
      <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <>
      <path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6" />
    </>
  ),
  play: <path d="m9 5 11 7-11 7z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  check: <path d="m6 12 4 4 8-9" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
      <path d="m8 11 3 3 5-5" />
    </>
  ),
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  external: <path d="M8 16 16 8m-6.5 0H16v6.5" />,
  build: (
    <>
      <path d="m14 4 6 6-3 3-6-6zM12 12 4 20m2-2-2-2" />
    </>
  ),
};
export function Symbol({
  name,
  size = 18,
  className = "",
}: {
  name: SymbolName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {paths[name]}
    </svg>
  );
}
export function Empty({
  icon = "cube",
  title,
  children,
  action,
}: {
  icon?: SymbolName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ac-empty">
      <Symbol name={icon} size={28} className="ac-empty-icon" />
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export type StateTone = "running" | "stopped" | "busy" | "attention";
export const stateTone = (state: string): StateTone =>
  state === "running"
    ? "running"
    : state === "stopped" || state === "not started"
      ? "stopped"
      : state === "starting" || state === "stopping"
        ? "busy"
        : "attention";
export const stateLabel = (state: string) =>
  `${state[0]?.toUpperCase() ?? ""}${state.slice(1)}`;
/** Filled for running, a ring for stopped, a dash while changing and a
 * diamond for anything unexpected, so state never depends on colour alone. */
export function Lamp({ state, tone }: { state: string; tone?: StateTone }) {
  return (
    <i
      className="ac-lamp"
      data-tone={tone ?? stateTone(state)}
      aria-hidden="true"
    />
  );
}
export function StateBadge({ state }: { state: string }) {
  return (
    <span className="ac-state" data-tone={stateTone(state)}>
      <Lamp state={state} />
      {stateLabel(state)}
    </span>
  );
}
export const shortImage = (reference: string) =>
  reference.replace(/^docker\.io\/library\//, "");
/** Parses the runtime's `address:host:container/proto` published-port form. */
export function publishedPort(value: string) {
  const match = /^(.*):(\d+):(\d+)(?:\/(\w+))?$/.exec(value);
  if (!match) return null;
  const address = match[1] === "0.0.0.0" ? "127.0.0.1" : match[1]!;
  return {
    host: Number(match[2]),
    guest: Number(match[3]),
    protocol: match[4] ?? "tcp",
    url: `http://${address === "127.0.0.1" ? "localhost" : address}:${match[2]}`,
    label: `${address === "127.0.0.1" ? "localhost" : address}:${match[2]}`,
  };
}
/** Rounds an axis ceiling up to 1, 2 or 5 times a power of ten. */
export function niceCeiling(value: number) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 5, 10].find((step) => step * power >= value) ?? 10) * power;
}
/** The same, in whole binary units so labels read 2 KiB rather than 2.1 KiB. */
export function niceBytes(value: number) {
  const unit =
    1024 **
    Math.max(0, Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)));
  return niceCeiling(value / unit) * unit;
}
export const formatBytes = (value: number): string => {
  if (value === 0) return "0 B";
  const power = Math.min(
    4,
    Math.max(0, Math.floor(Math.log(value) / Math.log(1024))),
  );
  return `${(value / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][power]}`;
};
/** Matches the 60 samples, five seconds apart, kept by useMetrics. */
export const CHART_SLOTS = 60;
export function Chart({
  values,
  label,
  ceiling,
  scale,
  idleMessage = "Waiting for samples…",
}: {
  values: number[];
  label: string;
  ceiling: number;
  /** The ceiling as text, shown at the top of the axis. */
  scale: string;
  idleMessage?: string;
}) {
  const max = ceiling;
  // Samples occupy fixed slots ending at "now", so a short history fills in
  // from the right instead of stretching across the whole time axis.
  const offset = Math.max(0, CHART_SLOTS - values.length);
  const x = (i: number) => ((offset + i) / (CHART_SLOTS - 1)) * 500;
  const points = values
    .slice(-CHART_SLOTS)
    .map((v, i) => `${x(i)},${98 - Math.min(1, Math.max(0, v / max)) * 90}`);
  return (
    <div className="ac-chart" role="img" aria-label={label}>
      <svg viewBox="0 0 500 100" preserveAspectRatio="none">
        <path className="ac-chart-base" d="M0 99.5H500" />
        {values.length > 1 && (
          <>
            <polygon
              className="ac-chart-area"
              points={`${x(0)},100 ${points.join(" ")} 500,100`}
            />
            <polyline
              className="ac-chart-line"
              vectorEffect="non-scaling-stroke"
              points={points.join(" ")}
            />
          </>
        )}
      </svg>
      {values.length > 1 && (
        <small className="ac-chart-scale" aria-hidden="true">
          {scale}
        </small>
      )}
      {values.length < 2 && (
        <span>{values.length ? "Collecting samples…" : idleMessage}</span>
      )}
    </div>
  );
}
