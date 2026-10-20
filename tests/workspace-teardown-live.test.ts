import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workspaceRuntime, workspaceTeardown } from "../lib/workspace-runtime";
import { workspaceTargetSchema } from "../lib/workspace-schema";
import { createRunner, snapshot } from "../lib/runtime";

it.skipIf(process.env.APPLE_CONTAINER_TEARDOWN_LIVE !== "1")(
  "tears down disposable real workspaces, retains reusable volume data and leaves pre-existing resources alone",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "bb-teardown-live-")),
    );
    const config = {
      binaryPath: "/opt/homebrew/bin/container",
      allowExternal: false,
    };
    const runner = await createRunner(config);
    const before = await snapshot(config, runner);
    expect(before.running).toBe(true);
    const target = workspaceTargetSchema.parse({
      projectId: `teardown-verify-${randomUUID()}`,
      environmentId: "first",
      path: directory,
      profile: {
        enabled: true,
        app: {
          name: "app",
          image: "alpine:3.23",
          command: ["sleep", "infinity"],
          memoryMiB: 256,
          volumes: [{ name: "proof", target: "/proof" }],
        },
      },
    });
    const other = { ...target, environmentId: "second" };
    const keep = { removeVolumes: false, dryRun: false };
    const purge = { removeVolumes: true, dryRun: false };
    try {
      const first = await workspaceRuntime(target, "ensure", directory, runner);
      const second = await workspaceRuntime(other, "ensure", directory, runner);
      const id = first.services[0]!.id;
      expect(
        (
          await runner(
            ["exec", id, "sh", "-c", "echo retained-proof > /proof/value"],
            10_000,
          )
        ).ok,
      ).toBe(true);
      const preview = await workspaceTeardown(
        target,
        { ...purge, dryRun: true },
        directory,
        runner,
      );
      expect(preview).toMatchObject({
        kind: "preview",
        containers: [id],
        volumes: first.services[0]!.volumes,
        retainedVolumes: [],
      });
      expect(
        (await workspaceRuntime(target, "status", directory, runner))
          .services[0]!.state,
      ).toBe("running");
      const removed = await workspaceTeardown(target, keep, directory, runner);
      expect(removed).toMatchObject({
        kind: "removed",
        containers: [id],
        retainedVolumes: first.services[0]!.volumes,
        volumes: [],
      });
      const middle = await snapshot(config, runner);
      expect(middle.containers.some((c) => c.id === id)).toBe(false);
      expect(
        middle.containers.find((c) => c.id === second.services[0]!.id)?.state,
      ).toBe("running");
      expect(middle.volumes).toEqual(
        expect.arrayContaining(first.services[0]!.volumes),
      );
      expect(
        (await workspaceRuntime(target, "status", directory, runner))
          .configured,
      ).toBe(false);
      await workspaceRuntime(target, "ensure", directory, runner);
      expect(
        (
          await runner(["exec", id, "cat", "/proof/value"], 10_000)
        ).stdout.trim(),
      ).toBe("retained-proof");
      await workspaceTeardown(target, keep, directory, runner);
      expect(
        await workspaceTeardown(target, purge, directory, runner),
      ).toMatchObject({
        kind: "removed",
        containers: [],
        volumes: first.services[0]!.volumes,
      });
      expect(
        await workspaceTeardown(target, purge, directory, runner),
      ).toMatchObject({ kind: "absent" });
    } finally {
      // These identities are unique to this test; no user runtime is selected.
      await workspaceTeardown(target, purge, directory, runner);
      await workspaceTeardown(other, purge, directory, runner);
      await rm(directory, { recursive: true, force: true });
    }
    const after = await snapshot(config, runner);
    expect(after.containers.map((c) => c.id).sort()).toEqual(
      before.containers.map((c) => c.id).sort(),
    );
    expect([...after.networks].sort()).toEqual([...before.networks].sort());
    expect([...after.volumes].sort()).toEqual([...before.volumes].sort());
  },
  240_000,
);
