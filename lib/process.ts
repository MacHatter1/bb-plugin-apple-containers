import { spawn } from "node:child_process";
import type { CommandResult } from "../contract";

export const OUTPUT_LIMIT = 256 * 1024;
export type Runner = (
  args: string[],
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<CommandResult>;

/** Drain both pipes even after the cap; settle only after the child is reaped. */
export function runProcess(
  binary: string,
  args: string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        ok: false,
        exitCode: 130,
        stdout: "",
        stderr: "Request cancelled before launch.",
        truncated: false,
      });
      return;
    }
    const child = spawn(binary, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };
    let bytes = 0,
      truncated = false,
      stopped = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const collect = (key: "out" | "err", chunk: Buffer) => {
      const room = Math.max(0, OUTPUT_LIMIT - bytes);
      if (chunk.length > room) truncated = true;
      if (room) chunks[key].push(chunk.subarray(0, room));
      bytes += Math.min(chunk.length, room);
    };
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () =>
      stop(
        "Request cancelled. The CLI was terminated; check container state before retrying. Guest commands may still be running.",
      );
    const timer = setTimeout(
      () =>
        stop(
          "Command timed out. The CLI was terminated; check container state before retrying. Guest commands may still be running.",
        ),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    // Close the race between the preflight check and listener registration.
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => collect("out", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("err", chunk));
    let launchError = "";
    child.on("error", (error) => {
      launchError = error.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      const stdout = Buffer.concat(chunks.out).toString("utf8");
      const stderr = [
        Buffer.concat(chunks.err).toString("utf8"),
        launchError,
        stopped,
      ]
        .filter(Boolean)
        .join("\n");
      const exitCode = stopped ? (signal?.aborted ? 130 : 124) : (code ?? 1);
      resolve({
        ok: exitCode === 0 && !launchError,
        exitCode,
        stdout,
        stderr,
        truncated,
      });
    });
  });
}
