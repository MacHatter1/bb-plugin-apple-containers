import type { CSSProperties, ReactNode } from "react";
export type SymbolName =
  | "cube"
  | "dashboard"
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
      <div className="ac-empty-icon">
        <Symbol name={icon} size={30} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function StateBadge({ state }: { state: string }) {
  return (
    <span
      className={`ac-state ${state === "running" ? "ac-state-running" : ""}`}
    >
      <i />
      {state[0]?.toUpperCase()}
      {state.slice(1)}
    </span>
  );
}
export const formatBytes = (value: number): string => {
  if (value === 0) return "0 B";
  const power = Math.min(
    4,
    Math.max(0, Math.floor(Math.log(value) / Math.log(1024))),
  );
  return `${(value / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][power]}`;
};
export function Chart({
  values,
  color = "var(--ac-blue)",
  label,
  ceiling,
  idleMessage = "Waiting for samples…",
}: {
  values: number[];
  color?: string;
  label: string;
  ceiling?: number;
  idleMessage?: string;
}) {
  const max = ceiling || Math.max(1, ...values) * 1.25;
  const points = values.map(
    (v, i) =>
      `${values.length === 1 ? 500 : (i / (values.length - 1)) * 500},${106 - Math.min(1, Math.max(0, v / max)) * 96}`,
  );
  return (
    <div
      className="ac-chart"
      style={{ "--chart-color": color } as CSSProperties}
      role="img"
      aria-label={label}
    >
      <svg viewBox="0 0 500 115" preserveAspectRatio="none">
        <path
          className="ac-chart-grid"
          d="M0 10H500M0 42H500M0 74H500M0 106H500"
        />
        {values.length > 1 && (
          <>
            <polygon
              fill="currentColor"
              opacity=".09"
              points={`0,112 ${points.join(" ")} 500,112`}
            />
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              points={points.join(" ")}
            />
          </>
        )}
      </svg>
      {values.length < 2 && (
        <span>{values.length ? "Collecting live samples…" : idleMessage}</span>
      )}
      <div className="ac-chart-axis">
        <span>Recent samples</span>
        <span>Now</span>
      </div>
    </div>
  );
}
