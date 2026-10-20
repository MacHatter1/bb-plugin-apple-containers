import { expect, it } from "vitest";
import { parseCommand } from "../lib/argv";
import { calculateSample } from "../ui/use-runtime";
import type { Metrics } from "../contract";
const point = (sampledAt: number, cpuUsageUsec: number): Metrics => ({
  sampledAt,
  containers: [
    {
      id: "app",
      cpuUsageUsec,
      memoryUsageBytes: 512,
      memoryLimitBytes: 1024,
      networkRxBytes: cpuUsageUsec,
      networkTxBytes: 0,
      blockReadBytes: 0,
      blockWriteBytes: 0,
      numProcesses: 1,
    },
  ],
});
it("derives CPU and I/O rates from counter deltas and elapsed time", () => {
  const result = calculateSample(point(6000, 3_000_000), point(1000, 500_000));
  expect(result.cpu.app).toBe(50);
  expect(result.rx.app).toBe(500_000);
});
it("does not fabricate CPU usage before a baseline or after a counter reset", () => {
  expect(calculateSample(point(1000, 500)).cpu.app).toBeNull();
  expect(
    calculateSample(point(2000, 100), point(1000, 500)).cpu.app,
  ).toBeNull();
});
it("parses quoted argv without expanding shell syntax", () => {
  expect(parseCommand(`sh -lc 'echo hello; uname -a'`)).toEqual([
    "sh",
    "-lc",
    "echo hello; uname -a",
  ]);
  expect(parseCommand(`echo 'a b' "" \`whoami\` $USER`)).toEqual([
    "echo",
    "a b",
    "",
    "`whoami`",
    "$USER",
  ]);
  expect(() => parseCommand(`echo 'unfinished`)).toThrow("Close the quote");
});
