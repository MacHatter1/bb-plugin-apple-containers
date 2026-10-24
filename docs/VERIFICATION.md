# Verification

## Current dashboard and Containers grouping

Verified on 24 October 2026 after the dashboard redesign:

- The full suite passes 129 tests across 11 files, including a fresh module-cache
  run; the two opt-in live-container tests remain skipped. Type checking,
  formatting, SDK compatibility, the plugin build and `git diff --check` pass.
- UI tests use the current navigation, status and action labels. The app is
  loaded in suite setup so cold component imports do not consume the first
  interaction test's timeout.
- Dashboard and Containers tests verify alphabetical project groups, membership
  across running and stopped containers, group counts, unassigned containers
  last, project search combined with state filters, and project names in details.
  Separate projects with the same name remain separate and sort by project ID.
- Rebuilt and reloaded the installed plugin. Current saved dashboard regression
  `flow_6c518182`, run `run_54fb9a26`, passed 9/9 (score 98). Its initial page load
  needed one readiness retry; all eight subsequent interactions passed directly.
  Navigation, the creation form's cancellation, search and monitoring were
  checked without starting or changing containers.
- The older saved dashboard/grouping plans still reference removed UI labels
  and Learn Anything containers that are no longer in the live inventory. Their
  reruns (`run_125e4506`, `run_50f042ca`) fail those stale assertions. The QA API
  does not support editing expected text, so the current dashboard flow above
  replaces that plan while retaining the original run history.
- The installed Dashboard bundle was also mounted with explicitly labelled,
  browser-only sample RPC responses. Learn Anything's app and stopped database,
  a second project and an unassigned container grouped correctly in both views.
  Project search, the Stopped filter and the details project name passed browser
  assertions; neither view overflowed at 1280 pixels. All mutation RPCs were
  blocked in this sample check. This verifies rendering, not another live
  container lifecycle run. The real inventory contained only Jev and buildkit;
  neither was changed.

## Standalone agent cleanup

Verified on 24 October 2026:

- 108 backend/runtime tests passed, including 14 new checks for agent cleanup.
  Type checking, the plugin build, SDK compatibility, formatting of the affected
  backend/test files and `git diff --check` passed.
- Installed CLI verification created two uniquely named, 256 MiB Alpine
  containers in this thread: one with task cleanup and one with manual cleanup.
  Both recorded the correct owning thread and Apple Containers project.
- After plugin reload, the dry run selected only the task container and retained
  the manual container. Cleanup removed the task container; repeating it removed
  nothing and left the manual container running. The manual fixture was then
  explicitly stopped/deleted. Final cleanup reported no remaining owned task or
  manual containers. Existing Jev and builder containers kept their identities
  and running states. Shared images were kept.
- Automated checks cover persisted Mac targets after a lost launch response,
  offline-host retries, caller scope, legacy/shared/manual exclusions, instance
  replacements, in-flight commands, failed and lost stop/delete outcomes,
  idempotence, clipped inventory and tool disablement.
- The earlier UI failures during the concurrent dashboard changes are covered
  by the current dashboard verification above. The disposable live container
  checks here exercise cleanup directly.

Verified locally on 20 October 2026 with BB Plugin SDK 0.6.49, Apple container CLI
1.5.0, Apple silicon and macOS 26.6.

## Code-review fixes

- Fresh verification: 100 automated tests passed; two optional live-container
  tests were skipped. Strict type checking, formatting, SDK 0.6.49 compatibility,
  plugin build and `git diff --check` passed.
- Regression coverage rejects colliding volume identities at setup/start while
  retaining legacy inspection and cleanup. Native exec reports pending startup
  and readiness failures; long guest commands leave status reads available.
- Replacement checks cover preflight failures, saved partial manifests,
  unavailable recovery, previously stopped stacks and first-use attempts.
  Changed-path recovery is exercised through stop, teardown and retirement.
  Cleanup previews remain read-only.
- The repeated independent Standards and Spec reviews found no remaining
  actionable P1/P2 findings after the follow-up retirement fixes.
- Rebuilt and reloaded the installed local plugin. Saved UI suite
  `suite_cdf4c1d7` passed 2/2 flows: thread badge `run_fd155bdd` and project
  controls `run_c5bdfb62`, each 7/7 with score 97. Each required one initial
  page-load retry; subsequent steps passed without selector changes. The older
  dashboard flows were not selected because dashboard resource code was
  unchanged by these fixes.
- These checks did not start, stop, recreate or delete live containers or
  databases. Existing Learn Anything runtimes and data were preserved.

## Project environment extension

The extension was built and installed locally on 20 October 2026.

- The initial project-environment implementation passed 75 automated tests.
  The teardown extension adds checks below; live-container tests are opt-in.
- Strict type checking, formatting, SDK 0.6.49 compatibility and the plugin build
  passed. The installed plugin reports running.
- `APPLE_CONTAINER_LIVE=1 npx vitest run tests/workspace-live.test.ts`: passed
  against real Apple containers, PostgreSQL 17, MySQL 8.4 and Alpine 3.23.
  An app served a mounted file over its published loopback port and installed
  Linux development tools. Its PostgreSQL client connected over the private
  workspace network. A second workspace had different ports and a separate,
  empty database. PostgreSQL and MySQL rows survived container replacement.
  The test removed all of its containers, volumes and networks; existing
  resources were left alone. The pulled image layers remain cached.
- The live check found and fixed database initialization at a volume root
  containing `lost+found`, preservation of the database image's PATH, and the
  Apple runtime's 200 MiB minimum memory requirement.
- The tests cover concurrent reuse, ownership conflicts, lost CLI outcomes,
  failed inventories, secret-file symlink escape, readiness ordering, explicit
  replacement after service-address/workspace-path changes, pinned recipes,
  tool routing/disablement and retirement reconciliation. Status reads do not
  publish change events, preventing a UI refresh loop.
- Native agent setup tests cover reading defaults and database presets before
  containers are enabled, deriving the project from the current thread,
  rejecting invalid profiles and project overrides, saving without host actions,
  persistence across plugin reload, and starting with the saved profile. The
  setup tool and expanded bundled skill were built and installed locally.
- Installed dashboard regression: `flow_2864d64e`, run `run_f676ac52`, 7/7 passed.
  New project controls: `flow_b4832a57`, latest run `run_e6240f74`, 7/7 passed
  after the native setup tool was installed. Each flow
  needed one initial page-readiness retry. The project flow made no saved
  settings changes and started no containers.
- The real project form was inspected with the Apple Containers project selected
  and the PostgreSQL preset in an unsaved draft. At a 530 CSS-pixel plugin width,
  scroll width equalled client width and the form stacked into one column.

Git and provider sessions remain on the Mac. The live check used disposable
workspaces, not the Learn Anything runtime or database snapshot. No live database
tunnel, existing database, remote Mac, or whole-provider container execution was
used. Worktree lifecycle integration is tested with the public SDK harness; the
live isolation check uses separate workspace identities and directories rather
than creating or retiring a real BB Git worktree.

## Task-completion teardown

- Final checks: 85 automated tests passed; two optional live tests skipped in
  the normal suite. Type checking, formatting and the plugin build passed.
- Added `apple_workspace_teardown` and `bb apple-containers workspace teardown`.
  Agent and skill instructions cover task completion, retained data, shared
  environments and explicit authorization for volume removal.
- Automated tests cover read-only previews, default volume retention, later
  removal without a host manifest, idempotence, volume reuse, orphan resources,
  ownership conflicts, failed inventories and interrupted cleanup. Server tests
  cover current-thread scope, paginated siblings, caller exclusion, in-flight
  command protection, tool disablement, CLI options, disabled profiles, failures
  and shared cleanup status. The header renders Cleaning up then Not started.
- `APPLE_CONTAINER_TEARDOWN_LIVE=1 npx vitest run tests/workspace-teardown-live.test.ts`
  passed with two uniquely named Alpine workspaces. Default cleanup removed a
  container and network; a file in its named volume survived a new container.
  Explicit cleanup removed retained volumes even after manifest removal. The
  second workspace stayed running until its own cleanup. Container, network and
  volume inventories exactly matched their pre-test inventories afterward.
- The plugin was built and installed locally. Installed CLI help exposes
  `--environment`, `--dry-run`, `--remove-volumes` and `--json`; a dry run correctly
  returned in-use for a hidden helper in the current environment, with no changes.
- Installed UI suite `suite_bf5e855f`: 3/3 flows passed, all score 97. Thread
  header `run_60b6a296`, project controls `run_1abddbe1`, dashboard `run_2430b815`.
  Existing Learn Anything runtimes and databases were not changed.

## Thread container indicator

- Strict type checking, all 67 automated tests, formatting, the plugin build and
  local installation passed after adding the header indicator.
- Public SDK tests cover quiet unconfigured threads, status without provisioning,
  shared startup visibility, pinned images even after disabling the profile,
  thread-scoped actions/logs, unavailable hosts and recovery from failed startup.
  UI tests cover service details, app links, logs, compact labels, pending stop,
  shared startup signals and realtime reconnection.
- The installed header component was inspected in BB at 1280 and 460 CSS pixels
  using browser-only runtime responses. The compact trigger measured 28 × 28
  pixels; the popover stayed inside the viewport with equal scroll/client widths.
  Running, Stopping and Stopped transitions and service log requests were checked.
  Open dashboard selected the actual current project and environment. The real
  unconfigured thread RPC returned null. No project profile or container was
  changed for these header checks; the browser responses were explicitly marked
  as sample data, and do not constitute another real-container runtime test.
- Installed regressions: suite `suite_9204d700`, both flows passed. Project
  controls: `run_39a37dfc`, 7/7; dashboard: `run_3503f362`, 7/7. Both used one
  initial page-readiness retry and scored 97.

## Intermittent badge visibility

- Reproduced the missing badge with a pending native container command: a
  second thread's status RPC could not finish until that command released the
  shared queue. The focused regression failed before the fix and passed after
  read-only status was removed from that server queue.
- Reproduced the hidden badge on a React Strict Mode effect remount. The new
  regression failed to find the badge before the fix and passed after request
  ownership was released during effect cleanup.
- Added checks that project metadata requires no host call, and that Checking
  remains visible while the first host inspection is pending.
- Fresh verification: strict type checking, 75 automated tests, formatting and
  the plugin build passed. The optional live-container test was not rerun.
- Installed the fix and checked the affected Learn Anything thread
  `thr_vjmak8gzjm` against its real project profile and three running services.
  A browser gate delayed only the status response: the metadata request rendered
  Checking immediately, and releasing the gate changed it to Running without
  the badge disappearing. No runtime responses were fabricated, no lifecycle
  actions were called, and no databases or profiles were changed.
- Saved read-only regression `flow_c7169fa2`, run `run_c3d9dead`: 7/7 passed.
  Suite `suite_87fea967` also passed both existing flows: project controls
  `run_fc564ad4` (7/7, score 94) and dashboard `run_946ef53c` (7/7, score 97).

## Original dashboard checks

- `npm test`: 40 passing tests across process handling, runtime policy, SDK
  integration, metric calculations and UI behaviour.
- `npm run typecheck`: passed with strict TypeScript.
- `npm run format:check`: passed.
- `bb plugin types --check`: SDK pin and installed host match at 0.6.49.
- `bb plugin build`: server, app and host artifacts built successfully.
- The public-SDK import scanner reports no violations or private dependencies.

Tests exercise literal argv execution, output draining/caps, cancellation,
termination, missing executables, option-injection rejection, container ownership
checks, external read/override policy, partial inventory failure, runtime health,
thread-machine routing, live settings, disabled tools and CLI parsing. UI tests
exercise the inspector, protected controls, command validation, creation sheet,
filtering, image navigation and switching views while a log request is still pending. Metrics tests verify elapsed-time counter deltas
and avoid invented CPU values on a first sample or counter reset.

## Live runtime

Through the installed `bb apple-containers` command:

- Created a disposable Alpine 3.23 container and executed `uname` and shell argv
  inside the guest; observed Linux `aarch64`.
- Read configuration, logs and a resource snapshot. Verified the non-empty CLI 1.5 image inventory shape and its image reference.
- Stopped, started, stopped and deleted that disposable container.
- Created a second disposable container with a project mount and loopback port
  mapping. The native mount reported `virtiofs (ro)` and rejected a write with
  `Read-only file system`. Inspect/list reported `127.0.0.1:18087:8080/tcp`.
- Removed those test containers. The demonstration worker was also stopped and deleted after the browser checks.
- Created a bounded-memory demonstration worker to exercise live charts. The
  dashboard reported measured CPU/memory and counter-derived network/disk rates.
- Executed `printf bb-console-verified` through the real browser console and
  observed its output.

A deliberate plugin reload interrupted one in-flight test CLI request. State was
inspected before the container was recreated. Reloads preserve running containers;
request interruption is not treated as proof that a runtime operation stopped.

Image build flag/path construction is validated and checked against installed CLI
help; a live Dockerfile build was not performed. No registry credentials, remote
Mac or whole-provider container execution were tested.

## Browser

Saved QA flow `flow_2864d64e`, run `run_2991fade`: **7/7 passed**, score 97.
Initial page readiness needed one automatic retry; all subsequent steps passed
with their explicit selectors. The flow covers the installed dashboard, images,
networks, opening/cancelling creation, container workspace and return navigation.
Earlier runs found test-selector and placeholder-assertion errors, which were
corrected before this passing flow.

Manual browser checks covered the running container inspector and console,
light/dark palettes and a 460 CSS-pixel plugin pane. At that width, navigation
becomes an icon rail and the source list stacks above the inspector. The pane’s
scroll width equalled its client width, with no horizontally overflowing elements.
Dark appearance was exercised with browser-local semantic tokens, without
changing saved user settings.

Screenshot machine labels are anonymised. Resource readings are from the real,
disposable demonstration workload; no chart data was fabricated.
