import type { CommandResult, Snapshot } from "../contract";
import { MANAGED_LABEL } from "../lib/runtime";
export const success = (stdout = ""): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: "",
  truncated: false,
});
export const container = (managed = true) => ({
  id: "demo-workspace",
  configuration: {
    image: { reference: "alpine:3.23" },
    labels: managed ? { [MANAGED_LABEL]: "true" } : {},
    resources: { cpus: 2, memoryInBytes: 1073741824 },
    creationDate: "2026-10-01T00:00:00Z",
    publishedPorts: [],
  },
  status: { state: "running", networks: [] },
});
export const readySnapshot: Snapshot = {
  supported: true,
  installed: true,
  running: true,
  version: "container CLI version 1.5.0",
  platform: "darwin / arm64",
  message: "Apple container service is running.",
  checkedAt: "2026-10-01T00:00:00Z",
  containers: [
    {
      id: "demo-workspace",
      image: "alpine:3.23",
      state: "running",
      managed: true,
      cpus: 2,
      memoryBytes: 1073741824,
      addresses: [],
      ports: [],
      createdAt: "2026-10-01T00:00:00Z",
    },
  ],
  images: [{ reference: "alpine:3.23", digest: "sha256:demo", size: 512 }],
  networks: ["default"],
  volumes: [],
  warnings: [],
  allowExternal: false,
};
