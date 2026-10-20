# Verification

Verified locally on 20 October 2026 with BB Plugin SDK 0.6.49, Apple container CLI
1.5.0, Apple silicon and macOS 26.6.

## Automated checks

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
