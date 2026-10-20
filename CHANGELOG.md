# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Apple container runtime dashboard with live resource charts.
- Davit- and Orchard-inspired sidebar and split container workspace.
- Configuration inspector, auto-refreshing log tail and guest command console.
- Container creation, lifecycle controls, image pulls and image builds.
- Read-only network and volume inventories.
- Ten native agent tools, machine-aware CLI commands and a bundled skill.
- Ownership checks, loopback ports, read-only mount defaults and bounded process execution.
- Tests, design references, live verification evidence and screenshots.
- Project container profiles with development images, app commands, PostgreSQL
  and MySQL presets, custom services and workspace-local environment files.
- Separate containers, networks, loopback ports and persistent data volumes for
  each BB checkout/worktree; shared instances for threads in the same workspace.
- Optional startup on agent activity, workspace-aware native tools and CLI,
  explicit container replacement, and data-preserving environment retirement.
- Agent setup tool to read and save project profiles, with reusable database
  presets and a bundled skill for configuring and verifying the full setup.
- Live thread-header container badge with worktree-specific services, ports,
  logs, start/stop controls, compact layout and dashboard navigation.
- Agent `apple_workspace_teardown` and `workspace teardown` CLI with dry runs,
  ownership preflight, shared-thread protection, retained volumes by default and
  explicit persistent-data removal. Task-completion guidance is bundled.

### Changed

- Mark the README, package descriptions, draft listing and bundled skill as
  work in progress (WIP).
- Align the README with the repository standard, including feature panels,
  expandable project setup guidance and the complete workspace command list.

### Fixed

- Reject project setups whose service and volume names resolve to the same
  volume, preserving existing volume identities and access to legacy cleanup.
- Track startup and readiness failures from native workspace exec commands
  without marking their subsequent guest commands as provisioning.
- Preserve pinned recipes after failed replacements and reconcile partial
  replacements with the host's saved manifest.
- Container status reads no longer wait behind long commands in the same
  worktree. Configured badges show Checking before the first runtime read,
  and header effect remounts immediately issue a fresh request.
