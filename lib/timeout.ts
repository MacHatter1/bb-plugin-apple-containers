import type { ContainerCommand } from "../contract";
export function timeoutFor(command: ContainerCommand): number {
  if (command.op === "build" || command.op === "pull" || command.op === "run")
    return 600_000;
  if (command.op === "exec") return command.timeoutSeconds * 1000;
  return 60_000;
}
