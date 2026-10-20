import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract";
import {
  checkMounts,
  createRunner,
  perform,
  snapshot,
  metrics,
} from "./lib/runtime";
import {
  readWorkspaceTarget,
  workspaceRuntime,
  workspaceTeardown,
} from "./lib/workspace-runtime";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async workspaceTarget(identity, ctx) {
      return readWorkspaceTarget(
        identity,
        ctx.experimental_paths.dataDir,
        AbortSignal.any([ctx.signal, ctx.lifecycle.signal]),
      );
    },
    async workspaceTeardown({ config, workspace, options }, ctx) {
      if (process.platform !== "darwin" || process.arch !== "arm64")
        throw new Error(
          "Select an Apple silicon Mac to clean up project containers.",
        );
      return workspaceTeardown(
        workspace,
        options,
        ctx.experimental_paths.dataDir,
        await createRunner(config),
        AbortSignal.any([ctx.signal, ctx.lifecycle.signal]),
      );
    },
    async workspace({ config, workspace }, ctx) {
      if (process.platform !== "darwin" || process.arch !== "arm64")
        throw new Error(
          "Select an Apple silicon Mac to use project containers.",
        );
      const { action, ...target } = workspace;
      return workspaceRuntime(
        target,
        action,
        ctx.experimental_paths.dataDir,
        await createRunner(config),
        AbortSignal.any([ctx.signal, ctx.lifecycle.signal]),
      );
    },
    async workspaceExec({ config, workspace, exec }, ctx) {
      if (process.platform !== "darwin" || process.arch !== "arm64")
        throw new Error(
          "Select an Apple silicon Mac to use project containers.",
        );
      const signal = AbortSignal.any([ctx.signal, ctx.lifecycle.signal]);
      const runner = await createRunner(config);
      if (
        ![workspace.profile.app, ...workspace.profile.services].some(
          (v) => v.name === exec.service,
        )
      )
        throw new Error(`Unknown workspace service: ${exec.service}`);
      const state = await workspaceRuntime(
        workspace,
        "status",
        ctx.experimental_paths.dataDir,
        runner,
        signal,
      );
      const service = state.services.find((v) => v.name === exec.service);
      if (!service || service.state !== "running")
        throw new Error(`Workspace service ${exec.service} is not running.`);
      return perform(
        {
          op: "exec",
          id: service.id,
          command: exec.command,
          timeoutSeconds: exec.timeoutSeconds,
          ...(exec.service === "app" ? { workdir: "/workspace" } : {}),
        },
        { ...config, allowExternal: false },
        runner,
        signal,
      );
    },
    async metrics(config, ctx) {
      return metrics(
        await createRunner(config),
        AbortSignal.any([ctx.signal, ctx.lifecycle.signal]),
      );
    },
    async snapshot(config, ctx) {
      const signal = AbortSignal.any([ctx.signal, ctx.lifecycle.signal]);
      // Report a missing binary in the dashboard without failing plugin load.
      const runner = await createRunner(config).catch((error) => async () => ({
        ok: false,
        exitCode: 127,
        stdout: "",
        stderr: error.message,
        truncated: false,
      }));
      return snapshot(config, runner, signal);
    },
    async perform({ config, command }, ctx) {
      if (process.platform !== "darwin" || process.arch !== "arm64")
        throw new Error("Select an Apple silicon Mac to use Apple containers.");
      await checkMounts(command);
      return perform(
        command,
        config,
        await createRunner(config),
        AbortSignal.any([ctx.signal, ctx.lifecycle.signal]),
      );
    },
  },
});
