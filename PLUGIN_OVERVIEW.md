# Apple Containers

Your Mac’s containers, ready for your BB agents.

Manage Apple’s container runtime from BB with a dashboard inspired by Davit and Orchard. Check runtime health, browse local resources, and watch live CPU, memory, network and disk I/O charts. Select a container for configuration, resource history, logs and a command console.

Create a detached Linux container with CPU/memory limits, environment variables, loopback ports and an optional read-only project folder. Pull OCI images, build from a Dockerfile, and run an image from the local library. Volumes and networks have read-only inventory views.

Six native agent tools and the `bb apple-containers` CLI use the same validated controls as the dashboard. Calls target the invoking thread’s environment machine; explicit host IDs support other enrolled Macs. Build and mount paths always refer to that selected machine.

By default, agents can control only containers created by this plugin. Reads include external containers. An operator setting enables external-container control when wanted. The plugin uses argv without a host shell, limits process output, and never exposes bulk prune or forced deletion. Disabling it leaves containers running.

Requirements: BB 0.46+, Plugin SDK 0.6.49+, Apple silicon, macOS 26+ and Apple’s container CLI. Verified with CLI 1.5.0. This supplies container tools; it does not move entire BB provider sessions into Linux containers.

Open Apple Containers in BB’s navigation after installing the local checkout. Native tools appear when a provider session is next constructed.

MIT licence. No telemetry or external account is added by this plugin. Image pulls/builds use the registries and network access of Apple’s runtime.
