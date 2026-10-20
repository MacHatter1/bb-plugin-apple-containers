import { expect, it } from "vitest";
import { OUTPUT_LIMIT, runProcess } from "../lib/process";

it("runs literal argv with no host shell", async () => {
  const literal =
    "$(touch /tmp/apple-container-should-not-exist); echo literal";
  const result = await runProcess(process.execPath, [
    "-e",
    "process.stdout.write(process.argv[1])",
    literal,
  ]);
  expect(result.ok).toBe(true);
  expect(result.stdout).toBe(literal);
});
it("drains oversized output and clearly reports the cap", async () => {
  const result = await runProcess(process.execPath, [
    "-e",
    `process.stdout.write('x'.repeat(${OUTPUT_LIMIT * 3})); process.stderr.write('y'.repeat(${OUTPUT_LIMIT}));`,
  ]);
  expect(result.ok).toBe(true);
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.stdout + result.stderr)).toBe(OUTPUT_LIMIT);
});
it("times out, reaps the CLI, and warns about remaining guest work", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    50,
  );
  expect(result.exitCode).toBe(124);
  expect(result.stderr).toContain("Guest commands may still be running");
});
it("cancels an active process and handles pre-aborted requests", async () => {
  const controller = new AbortController();
  const result = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    10_000,
    controller.signal,
  );
  controller.abort();
  expect((await result).exitCode).toBe(130);
  expect(
    (await runProcess("/missing", [], 100, controller.signal)).exitCode,
  ).toBe(130);
});
it("reports a missing executable without hanging", async () => {
  const result = await runProcess("/missing/apple-container", []);
  expect(result.ok).toBe(false);
  expect(result.stderr).toContain("ENOENT");
});
