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
