import type { ContainerCommand } from "../contract";

/** Kept free of Node imports so the dashboard can preview the exact argv. */
export const MANAGED_LABEL = "app.getbb.apple-containers.managed";
export type RunCommand = Extract<ContainerCommand, { op: "run" }>;

export function runArgs(command: RunCommand, ownerArgs: string[] = []) {
  return [
    "run",
    "--detach",
    "--name",
    command.name,
    "--label",
    `${MANAGED_LABEL}=true`,
    ...ownerArgs,
    "--cpus",
    String(command.cpus),
    "--memory",
    `${command.memoryMiB}M`,
    ...command.env.flatMap((e) => ["--env", e]),
    ...command.ports.flatMap((p) => [
      "--publish",
      `127.0.0.1:${p.host}:${p.guest}`,
    ]),
    ...command.mounts.flatMap((m) => [
      "--mount",
      `type=bind,source=${m.source},target=${m.target}${m.readOnly ? ",readonly" : ""}`,
    ]),
    ...(command.workdir ? ["--workdir", command.workdir] : []),
    command.image,
    ...command.command,
  ];
}
