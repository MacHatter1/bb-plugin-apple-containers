**Work in progress (WIP).** This plugin is under active development. Features,
configuration and behaviour are still evolving. This is a draft listing for
the WIP source on GitHub.

Your Mac’s containers, ready for your BB agents.

Manage Apple’s container runtime from BB with a dashboard inspired by Davit and Orchard. Check runtime health, browse local resources, and watch live CPU, memory, network and disk I/O charts. Select a container for configuration, resource history, logs and a command console.

Create a detached Linux container with CPU/memory limits, environment variables, loopback ports and an optional read-only project folder. Pull OCI images, build from a Dockerfile, and run an image from the local library. Volumes and networks have read-only inventory views.

Ten native agent tools and the `bb apple-containers` CLI use the same validated controls as the dashboard. Agents can read and save project container setups, then start and use separate app, database and tooling containers for each worktree. A thread-header badge shows the workspace's container state, service images, ports and logs. A teardown command removes finished workspace containers and networks, preserves volumes by default, and refuses while another thread is active in that environment. Explicit data removal is available separately. Calls target the invoking thread’s project and environment machine; the low-level tools accept explicit host IDs for other enrolled Macs. Build and mount paths always refer to that selected machine.

By default, agents can control only containers created by this plugin. Reads include external containers. An operator setting enables external-container control when wanted. The plugin uses argv without a host shell, limits process output, and never exposes bulk prune or forced deletion. Disabling it leaves containers running.

Requirements: BB 0.46+, Plugin SDK 0.6.49+, Apple silicon, macOS 26+ and Apple’s container CLI. Verified with CLI 1.5.0. This supplies container tools; it does not move entire BB provider sessions into Linux containers.

Open Apple Containers in BB’s navigation after installing from GitHub or a local checkout. Native tools appear when a provider session is next constructed.

MIT licence. No telemetry or external account is added by this plugin. Image pulls/builds use the registries and network access of Apple’s runtime.
