import { expect, it } from "vitest";
import { formatCommand, formatCommandLines, parseCommand } from "../lib/argv";

it("formats argv as a command line that parses back to the same argv", () => {
  for (const argv of [
    ["sleep", "infinity"],
    ["sh", "-lc", "npm ci && npm run dev -- --hostname 0.0.0.0"],
    ["echo", "it's", ""],
    ["--env", "GREETING=hello world", "--publish", "127.0.0.1:8080:80"],
  ])
    expect(parseCommand(formatCommand(argv))).toEqual(argv);
  expect(formatCommand(["--memory", "1024M", "alpine:3.23"])).toBe(
    "--memory 1024M alpine:3.23",
  );
});

it("splits long commands into continued lines that still parse to the same argv", () => {
  const argv = [
    "container",
    "run",
    "--detach",
    "--name",
    "api",
    "--env",
    "GREETING=hello world",
    "alpine:3.23",
    "sh",
    "-lc",
    "echo --not-a-flag",
  ];
  const text = formatCommandLines(argv, ["run", "--detach"]);
  expect(text).toBe(
    "container run --detach \\\n  --name api \\\n  --env 'GREETING=hello world' \\\n  alpine:3.23 sh -lc 'echo --not-a-flag'",
  );
  expect(parseCommand(text)).toEqual(argv);
});
