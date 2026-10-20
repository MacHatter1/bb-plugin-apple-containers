---
name: apple-containers
description: Configure project app, database and development-tool containers from an agent, run Linux work in Apple's container runtime, or inspect and manage BB containers and images.
---

# Apple Containers

Work in progress (WIP): features, configuration and behaviour are still evolving.

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
- `apple_workspace({action?})`: `ensure` (default), `status`, or `stop` for the invoking thread's project checkout/worktree. Uses the project's saved profile, reuses its containers and ports, and preserves named data volumes. No host override.
- `apple_workspace_exec({command,service?,timeoutSeconds?})`: ensures that workspace, then executes argv in the named service (default `app`, working directory `/workspace`). Timeout defaults to 60 seconds, range 1–600. No host override.
- `apple_workspace_setup({profile?})`: no arguments reads the current thread's project profile (or null), a default development profile, and PostgreSQL/MySQL presets. Supplying a complete `profile` saves the project setup. It always resolves the project from the thread, accepts no project/host override, and does not start or replace containers.
- `apple_workspace_teardown({removeVolumes?,dryRun?})`: stop/delete this thread's workspace containers and network after the task is finished. Named volumes stay by default. `removeVolumes:true` also deletes persistent data; use only with explicit authorization. `dryRun:true` previews without mutations. No project, environment or host override.

## Set up a project from a request

When the user asks for a project's app, database or development environment:

1. Call `apple_workspace_setup({})`. Read the repository's manifests, Dockerfiles,
   existing service definitions and environment-file examples to determine its
   required tools, versions, commands and ports.
2. Adapt the returned `defaultProfile` instead of guessing the schema. The shape
   is `{enabled,autoStart,app,services}`. Set `enabled:true` to use the setup.
   `app` must be named `app`; up to four additional services have distinct names.
   Use an existing image with the required development tools, or build one with
   `apple_container_image`. Remove the default Node dependencies volume for a
   non-Node project when it is unnecessary.
3. Use a returned `databasePresets.postgres` or `databasePresets.mysql` when
   appropriate. These include the correct persistent-data subdirectory and TCP
   readiness check. Add other services using the same service schema. Each can
   set `name`, `image`, `command`, `envFile`, `ports`, `cpus`, `memoryMiB`, `volumes`,
   `ready` and `readyTimeoutSeconds`. Volumes use `{name,target}`; memory must be
   at least 200 MiB. Service and volume names are local to this setup.
4. Keep credentials in ignored, workspace-local files referenced by `envFile`.
   Use a secure credential mechanism for user-supplied secrets; local development
   passwords may be generated and written privately without printing them. Do
   not put credentials in tool arguments, commands saved in the profile, or the
   conversation. Follow repository rules for databases, seeding and worktrees.
   Do not copy database snapshots or use production connections.
5. Call `apple_workspace_setup({profile: ...})` with the complete setup. It saves
   the template for the project and future worktrees. Read an existing profile
   before editing it so unrelated services and settings are preserved.
6. If startup is part of the request, call `apple_workspace({action:"ensure"})`,
   then verify app and database behavior with `apple_workspace_exec` and the
   returned loopback ports. If the request is only to configure the template,
   leave containers stopped. Saving alone never replaces an existing instance;
   applying an update to running containers requires the user's request to do so.
   When that update is requested, `bb apple-containers workspace recreate`
   applies the saved recipe to this thread's instance. It replaces containers
   and their root filesystems while retaining named volumes; it performs no
   database migration. Use it only for the requested instance.

The default profile is a starting point, not a promise that it contains every
tool the repository needs. A setup request does not authorize deleting existing
data volumes, changing unrelated projects, or overwriting local secret files.

## Project setups and worktrees

Configured threads have a container-status cube in their header. Clicking it
shows this checkout/worktree's services, images, ports, persistent volume counts,
logs and Start / reuse or Stop controls. Open dashboard selects that same
environment. Threads sharing a worktree share its stack. Reading the badge never
starts containers; Running means the containers run, not that an app is ready or
that every agent command is automatically redirected into Linux.

Configure **Apple Containers → Projects** once per project. The app,
database services, named volumes, network, and host ports are separate for every
BB environment. Multiple threads in the same worktree share one stack. A project
can opt into background startup when an agent becomes active.

When project-specific instructions report a configured container setup, call
`apple_workspace({action:"ensure"})` before app commands, builds, installs or
tests; automatic startup may still be in progress. Use `apple_workspace_exec`
for these commands, and the Mac for Git. The source directory is mounted
read/write at `/workspace`. The default development profile isolates Linux
`node_modules` in a named volume. Container images must include the required
tools, or install them explicitly as part of the project's command.

A source-based auxiliary service such as a Go API can set `mountWorkspace:true`.
This mounts the checkout at `/workspace` and supplies connections to earlier
services in profile order. Keep databases and caches before the API, then the
app. Mounted services receive `BB_WORKSPACE_PORT_<guest>` for their own published
ports and `<SERVICE>_PUBLISHED_PORT` for earlier services. They also receive a
read-only `BB_WORKSPACE_SERVICES_FILE` JSON file with current service states,
addresses and ports. Refresh the file when opening a connection: Apple container
addresses can change after restart. Opted-in services use that live file instead
of requiring the app container to be recreated when addresses change. No secrets
are written to that file. Ordinary database/cache services are not source-mounted.

Services start before the app, with optional `ready` argv and
`readyTimeoutSeconds` (default 90, maximum 300). Database presets include TCP
readiness checks. The app receives `<SERVICE_NAME>_HOST` and
`<SERVICE_NAME>_PORT` (first service port); `database` becomes `DATABASE_HOST`
and `DATABASE_PORT`. Newly created app containers also receive
`BB_WORKSPACE_PORT_<guest>` for each published app port, containing its host
loopback port. For example, use `BB_WORKSPACE_PORT_3000` to form an app's public
local URL. Existing containers receive these variables when recreated.
Use the returned host loopback ports for browser checks
on that Mac. A running container alone does not prove app readiness.

Profile environment-file paths are relative to each workspace. Their contents
stay on its Mac and are not returned in tools or saved in project settings.
Missing files fail before resource creation. Do not copy secrets, seed snapshots
or databases between worktrees yourself; follow the repository's rules. No
database seed is restored automatically. Never redirect tests to a live database.

Reuse active instances. Stopping them preserves data. Do not recreate them,
delete volumes, or restart another task's services without user intent. Updated
project recipes apply to new instances; the user can apply saved setup to an
existing one from the dashboard. This replaces containers but keeps named
volumes; it is not a database upgrade or migration mechanism. Environment
removal stops its stack; archiving one thread does not. Reload/disable leaves
containers running. Pending removal cleanup is reconciled every minute.

## Finish a task and clean up

After the task's last build, test or app command, call
`apple_workspace_teardown({})` when no further container work is needed. Follow
user and repository instructions to keep an app, seeded test runtime or shared
environment running. Do not tear down at intermediate pauses or while waiting
for user input. Do not remove a runtime set up specifically to remain available.

Default teardown stops and deletes workspace-owned containers and their writable
root filesystems, then deletes the workspace network. Source files, named volumes
(including databases and dependency caches), and shared images remain. A later
`apple_workspace({action:"ensure"})` creates containers using the retained volume
names. Changes stored only inside container root filesystems are lost.

The tool checks other threads sharing this BB environment, including hidden
threads. If another thread is active, starting, stopping or pending, it returns
`kind:"in-use"` with the thread IDs and changes nothing. Report the deferral;
the last task can perform cleanup. A running workspace command also blocks
teardown. Separate worktrees are unaffected. This guard is a current thread-state
check, not a cross-process reservation against a new thread starting later.

Use `dryRun:true` to inspect the exact owned resource names. When the user has
explicitly authorized deleting persistent data, use `removeVolumes:true` to
remove this environment's named volumes too, including volumes left by older
service recipes. Never infer that authorization from ordinary task completion.
Report retained volumes so the user knows what still consumes disk space. Images
are shared caches and are never pruned by teardown. A failed or timed-out cleanup
can be partial: inspect status and preview resources before retrying.

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
bb apple-containers workspace up
bb apple-containers workspace status --json
bb apple-containers workspace stop
bb apple-containers workspace teardown --dry-run --json
bb apple-containers workspace teardown
# Only when deletion of persistent data is authorized:
bb apple-containers workspace teardown --remove-volumes
# Only when asked to apply a saved update to this instance:
bb apple-containers workspace recreate
```

The low-level operational commands accept `--host <machine-id>` and `--json`. Outside a
thread choose a host, set `defaultHostId`, or have exactly one enrolled machine.
Workspace CLI commands accept `--environment <id>` instead of a host override;
inside a thread they default to its environment. They also support `--json`.
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
- This plugin attaches app/tooling services to existing BB checkout/worktree
  environments. It does not run an entire agent provider session inside Linux
  or replace BB's environment provider.
