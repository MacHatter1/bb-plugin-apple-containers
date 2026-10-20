---
name: apple-containers
description: Run Linux work in Apple's container runtime from BB, inspect runtime health and logs, or manage BB-created containers and images.
---

# Apple Containers

Prefer the native `apple_container_*` tools when available. Check
`apple_container_status` before starting work. The tools run on the invoking
thread's environment machine. Supply `hostId` explicitly to target another Mac.
This requires Apple silicon, macOS 26+ and Apple's `container` CLI (tested with
1.5.0). Installation and kernel setup remain operator actions.

## Tools

- `apple_container_status({hostId?})`: runtime, containers, images, networks, volumes.
- `apple_container_run({name,image,command?,cpus?,memoryMiB?,env?,ports?,mounts?,workdir?,hostId?})`: detached container. Defaults: 2 CPUs, 1024 MiB, image's default command. For a development workspace use `command:["sleep","infinity"]` with a compatible image.
- `apple_container_exec({id,command,workdir?,timeoutSeconds?,hostId?})`: argv inside the guest; timeout defaults to 60 seconds (1–600).
- `apple_container_read({id,view,lines?,hostId?})`: view `inspect`, `logs`, or `stats`. Logs default to 200 lines (1–2000).
- `apple_container_manage({action,id?,hostId?})`: `start`, `stop`, `delete`, or `system-start`. Delete requires a stopped container. `system-start` omits id and never installs a kernel automatically.
- `apple_container_image({action,image,context?,file?,hostId?})`: `pull`, or `build` with an absolute context directory and optional absolute Dockerfile path on that Mac.

## Commands

```sh
bb apple-containers hosts --json
bb apple-containers status --json
bb apple-containers list --json
bb apple-containers run --name task-workspace alpine:3.23 -- sleep infinity
bb apple-containers exec task-workspace -- uname -a
bb apple-containers logs task-workspace --lines 100
bb apple-containers inspect task-workspace --json
bb apple-containers stats task-workspace --json
bb apple-containers stop task-workspace
bb apple-containers start task-workspace
bb apple-containers delete task-workspace
bb apple-containers pull alpine:3.23
bb apple-containers build /absolute/project --tag my-app:dev
bb apple-containers system start
```

All operational commands accept `--host <machine-id>` and `--json`. Outside a
thread choose a host, set `defaultHostId`, or have exactly one enrolled machine.
Use `bb apple-containers <command> --help` for complete flags. Run supports
`--cpus`, `--memory` in MiB, repeated `--env KEY=value`, `--port 8080:80`,
`--mount /source:/workspace:ro` (or `:rw`), and `--workdir /workspace`.
Exec supports `--timeout` in seconds and `--workdir`.

## Operating rules

- Commands are argv arrays, without a host shell. To run a script in the guest,
  explicitly use `["sh","-lc","your script"]`.
- All build and mount paths refer to the selected Mac. Mount only folders needed
  for the task; default mounts are read-only and ports bind to loopback.
- Only containers bearing `app.getbb.apple-containers.managed=true` can be
  started, stopped, deleted or exec'd by default. `allowExternal` is an operator
  setting. Inspect and logs may read external containers. Do not change the
  setting to bypass protection without user intent.
- Never stop/delete another task's container. No bulk prune or forced deletion
  is exposed. Disabling the plugin does not stop containers.
- Pull, build and run allow ten minutes. A timeout or cancellation terminates
  the CLI; guest commands and runtime operations may continue. Inspect state
  before retrying. Do not blindly retry mutations.
- Output is bounded: 256 KiB per CLI process, 500 dashboard records per list,
  48,000 characters in native tool responses. Clipping is reported.
- `enableAgentTools=false` hides native tools on the next session resolution
  and rejects their execution immediately. The CLI and dashboard remain usable.
- This plugin supplies container tools; it does not run an entire BB agent
  provider session inside Linux or register container-backed BB environments.
