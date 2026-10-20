import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract";
import {
  checkMounts,
  createRunner,
  perform,
  snapshot,
  metrics,
} from "./lib/runtime";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
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
