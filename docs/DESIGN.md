# Apple Containers

The workspace follows the user’s Davit and Orchard references. A source sidebar
separates dashboard, containers, images, volumes and networks. The dashboard
groups service health, resource inventory, live monitoring and running containers.
The container workspace has a searchable source list and a full detail area.

The design uses BB’s semantic surfaces and type colours, with blue actions and
CPU, purple memory, green network and pink disk charts. System sans-serif text
anchors controls; monospace is reserved for commands and identifiers. Compact
panes collapse navigation labels and stack the source list above the inspector.
No replica window chrome or traffic-light controls are added inside BB.

The theme’s base tokens adapt light/dark surfaces. The blue action fill has a
separate dark value from the lighter chart/selection colour so button text stays
legible. Focus is visible, reduced motion is respected, and data is not encoded
only by colour. Charts show only observed samples. CPU requires two samples;
network/disk rates come from byte counters, and memory is measured usage.

Reference screenshots were inspected before the redesign:

- [Davit dashboard and container list](https://davit.app)
- [Orchard dashboard and split container workspace](https://github.com/andrew-waters/orchard)
- [ContainerUI inspector](https://github.com/kylemclaren/container-ui)

These informed layout and interactions. No upstream application source or artwork
is bundled. Apple HIG layout, sidebars, split views, toolbar, typography, colour
and accessibility guidance informed the desktop adaptation. The initial flat
table was replaced after the user requested a stronger Apple container UI.

The server registers contracts, settings, tools and commands. A typed host entry
runs Apple's CLI on the selected machine. Native tools default to the invoking
thread's environment host; commands outside a thread require an explicit host,
a configured default, or exactly one enrolled host. All paths are host-local.

Containers use the label `app.getbb.apple-containers.managed=true`. By default
start, stop, delete and exec inspect that label before executing. This ownership
check prevents accidental changes; it is not a security boundary between agents
that share the same Mac user. Reads include external containers.

Execution uses spawn with argv and no shell. Mounts default to read-only;
published ports bind to 127.0.0.1. The plugin never prunes resources, forces
deletion, forwards SSH, or automatically installs Apple software. No container
is stopped when BB reloads or disables the plugin.

Each subprocess drains both output pipes, retains at most 256 KiB, and is reaped
on timeout or request/lifecycle cancellation. Killing the CLI does not prove a
guest command, pull, or build has stopped; errors explicitly require inspecting
state before retrying. Mutations are never automatically retried by this plugin.
Structured lists reject clipped JSON and show partial-read warnings. Dashboard
collections are capped at 500 entries; agent text is capped at 48,000 characters.

## Upstream contracts

- [Apple container](https://github.com/apple/container)
- [Apple command reference](https://github.com/apple/container/blob/main/docs/command-reference.md)
- Installed CLI 1.5.0 help and JSON outputs were used for flag and shape checks.
- BB Plugin SDK 0.6.49 declarations are the extension contract.

Agents remain BB sessions on their selected host. The tools execute work inside
Linux containers; this plugin does not register a container as a BB machine or
move an entire provider session into a container.

## Project environments

Project profiles describe the development image, its command and ports, service
images, readiness commands, relative environment-file paths and named volumes.
Profiles live in plugin KV storage. A workspace binding pins its recipe until an
explicit replacement, and records its BB project, environment, machine and path.
Container identity uses a digest of the project/environment IDs on that machine;
branch changes and additional threads do not create new instances.
Saving or starting a setup rejects service/volume name pairs that generate the
same volume identifier. Existing volume names remain stable, and older ambiguous
profiles stay readable for inspection and explicit cleanup.

The host keeps an atomic manifest in its persistent plugin data directory before
creating resources. It inspects the current runtime on every operation, checks
workspace ownership labels, and serializes operations per workspace. A failed
inventory is never treated as an empty runtime. A timeout leaves the manifest
available for inspection and explicit recovery instead of retrying mutations.
An existing recipe pin changes after a successful host operation. On failure,
a read-only manifest lookup reconciles it with any partial host replacement;
an unavailable host leaves the previous pin intact and cleanup pending. Stop,
teardown and retirement resolve the host manifest again, including its saved
path, so cleanup can recover when that host reconnects.
All service environment files are validated before resource creation. Their
contents pass directly from the Mac to the container CLI and are not persisted
in project profiles or returned by workspace state calls.

Each instance has a separate network, loopback port allocation and named data
volumes. Database presets use a data subdirectory because an Apple volume's root
contains filesystem metadata. Readiness checks complete before the app starts.
The app receives service addresses through generated environment variables; if
an address changes later, an explicit replacement is required. Routine reuse
never silently replaces a container and discards its root filesystem.

The app mounts only its workspace at `/workspace`, read/write. Worktree `.git`
files can refer to shared metadata outside that mount. Git operations remain on
the Mac; tooling that needs Git metadata must run there or receive the required
version information from the host. The plugin does not mount a wider source
checkout automatically. The default development profile puts Linux
`node_modules` in a separate volume rather than the Mac directory.

Thread activity can start opted-in profiles in the background. Dynamic agent
instructions and workspace tools await provisioning before development commands;
this is workflow guidance, not interception of arbitrary shell tools. BB's
existing environment providers continue to own worktree provisioning and
retirement. Actual environment removal stops the stack, and a minute-based
reconciler retries missed/offline cleanup. Neither routine thread archival nor
plugin reload stops a stack directly. Containers, networks and data volumes are
retained; no automatic volume pruning or database seeding is performed.

Task completion has an explicit `apple_workspace_teardown` tool and matching
CLI command. The server checks paginated environment threads (including hidden
ones), excludes the caller, and refuses if another is active/starting/stopping/
pending or a workspace command is in flight. It checks again inside its command
queue. A fresh thread can still start after the check; this is not a distributed
lease. No idle event triggers teardown: waiting for a user is not task completion.

The host locks the workspace, inventories containers/networks/volumes, validates
expected names and owner labels before any mutation, then stops/deletes owned
containers and deletes owned networks. `removeVolumes` additionally removes all
volumes bearing this workspace's labels, including older recipes. Otherwise
volume names are reported as retained. Shared images and bind-mounted source
files are untouched. Dry runs do not migrate manifests or save bindings. A host
manifest is removed only after successful requested cleanup; pinned server
bindings remain for later inspection, reuse, or retained-volume removal.

## Thread container status

The public thread-header slot renders one badge per visible thread. Its RPC
resolves that thread's environment, reads its pinned recipe and inspects the
runtime without provisioning it. Shared worktree operations publish their start
and completion; status reads are coalesced and never publish refresh events.
Provisioning stays visible as Starting while host work is pending. A failed
inventory produces Unavailable, and a partial stack or failed operation needs
attention. Running reports container process state, not application readiness.
Native workspace exec uses this same provisioning lifecycle before launching a
guest command. Its long-running command does not keep the badge in Starting.

The portalled popover shows service images, observed states, loopback ports,
persistent volume counts and bounded logs. Lifecycle actions resolve the thread
again on the server and preserve data. The dashboard link selects the same
project, environment and Mac. The badge uses 28px controls and collapses to an
accessible cube icon on compact viewports. Polling pauses in hidden windows and
reconciles on visibility and realtime reconnection. Per-thread component keys
and request generations prevent old responses from updating another thread.

The first header request reads only project and binding metadata, showing
Checking before a host inspection completes. Read-only status calls bypass the
server's per-workspace command queue; the host's manifest lock still protects
inspection during lifecycle changes. Builds and tests therefore cannot block
the badge behind their execution. An in-flight read is owned by its request
generation, and effect cleanup releases that ownership so an immediate remount
starts a new read rather than waiting for the eight-second polling interval.
