import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workspaceKey, workspaceRuntime } from "../lib/workspace-runtime";
import { workspaceTargetSchema } from "../lib/workspace-schema";
import { createRunner, snapshot } from "../lib/runtime";
import { databasePreset } from "../lib/workspace-presets";

it.skipIf(process.env.APPLE_CONTAINER_LIVE !== "1")(
  "isolates real workspaces, serves mounted app files, and keeps database volume data across recreation",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "bb-workspace-live-")),
    );
    const runner = await createRunner({
      binaryPath: "/opt/homebrew/bin/container",
      allowExternal: false,
    });
    const password = randomUUID();
    const mainPath = join(directory, "main");
    const featurePath = join(directory, "feature");
    for (const path of [mainPath, featurePath]) {
      await mkdir(path);
      await writeFile(
        join(path, ".database.env"),
        `POSTGRES_PASSWORD=${password}\nPOSTGRES_DB=workspace_verify\nPGUSER=postgres\nPGDATABASE=workspace_verify\nPGPASSWORD=${password}\n`,
        { mode: 0o600 },
      );
    }
    const target = workspaceTargetSchema.parse({
      projectId: `verify-${randomUUID()}`,
      environmentId: "main",
      path: mainPath,
      profile: {
        enabled: true,
        app: {
          name: "app",
          image: "alpine:3.23",
          envFile: ".database.env",
          command: [
            "sh",
            "-c",
            "apk add --no-cache busybox-extras postgresql-client && exec busybox-extras httpd -f -p 3000",
          ],
          ready: ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/"],
          ports: [3000],
          memoryMiB: 256,
        },
        services: [
          { ...databasePreset("postgres", ".database.env"), memoryMiB: 512 },
        ],
      },
    });
    const targets = [
      target,
      { ...target, environmentId: "feature", path: featurePath },
    ];
    let primary: unknown;
    async function ready(id: string) {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (
          (
            await runner(
              [
                "exec",
                id,
                "pg_isready",
                "-U",
                "postgres",
                "-d",
                "workspace_verify",
              ],
              5000,
            )
          ).ok
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("PostgreSQL did not become ready");
    }
    try {
      await writeFile(join(mainPath, "index.html"), "workspace-app-verified");
      await writeFile(join(featurePath, "index.html"), "feature-app-verified");
      const first = await workspaceRuntime(target, "ensure", directory, runner);
      const other = await workspaceRuntime(
        targets[1]!,
        "ensure",
        directory,
        runner,
      );
      const app = first.services.find((v) => v.name === "app")!;
      const database = first.services.find((v) => v.name === "database")!;
      expect(other.services[0]!.volumes).not.toEqual(database.volumes);
      expect(
        other.services.find((v) => v.name === "app")!.ports[0]!.host,
      ).not.toBe(app.ports[0]!.host);
      expect(
        await (await fetch(`http://127.0.0.1:${app.ports[0]!.host}`)).text(),
      ).toBe("workspace-app-verified");
      expect(
        await (
          await fetch(
            `http://127.0.0.1:${other.services.find((v) => v.name === "app")!.ports[0]!.host}`,
          )
        ).text(),
      ).toBe("feature-app-verified");
      await ready(database.id);
      expect(
        (
          await runner(
            [
              "exec",
              database.id,
              "psql",
              "-U",
              "postgres",
              "-d",
              "workspace_verify",
              "-c",
              "CREATE TABLE proof (value text); INSERT INTO proof VALUES ('persistent-proof');",
            ],
            30_000,
          )
        ).ok,
      ).toBe(true);
      const otherDb = other.services.find((v) => v.name === "database")!;
      await ready(otherDb.id);
      expect(
        (
          await runner(
            [
              "exec",
              otherDb.id,
              "psql",
              "-U",
              "postgres",
              "-d",
              "workspace_verify",
              "-Atc",
              "SELECT to_regclass('proof') IS NULL",
            ],
            30_000,
          )
        ).stdout.trim(),
      ).toBe("t");
      const query = await runner(
        [
          "exec",
          app.id,
          "sh",
          "-lc",
          'psql -h "$DATABASE_HOST" -p "$DATABASE_PORT" -Atc \'SELECT value FROM proof\'',
        ],
        30_000,
      );
      expect(query.stdout.trim(), query.stderr).toBe("persistent-proof");
      const reused = await workspaceRuntime(
        target,
        "ensure",
        directory,
        runner,
      );
      expect(reused.services.map((v) => v.id)).toEqual(
        first.services.map((v) => v.id),
      );
      await workspaceRuntime(target, "stop", directory, runner);
      expect(
        (
          await workspaceRuntime(targets[1]!, "status", directory, runner)
        ).services.every((v) => v.state === "running"),
      ).toBe(true);
      const recreated = await workspaceRuntime(
        target,
        "recreate",
        directory,
        runner,
      );
      const restoredDb = recreated.services.find((v) => v.name === "database")!;
      await ready(restoredDb.id);
      expect(
        (
          await runner(
            [
              "exec",
              restoredDb.id,
              "psql",
              "-U",
              "postgres",
              "-d",
              "workspace_verify",
              "-Atc",
              "SELECT value FROM proof",
            ],
            30_000,
          )
        ).stdout.trim(),
      ).toBe("persistent-proof");
      const vars = await runner(
        [
          "exec",
          recreated.services.find((v) => v.name === "app")!.id,
          "printenv",
          "DATABASE_HOST",
        ],
        30_000,
      );
      expect(vars.stdout.trim()).toBe(
        recreated.services.find((v) => v.name === "database")!.address,
      );
      for (const item of targets)
        await workspaceRuntime(item, "stop", directory, runner);
      await writeFile(
        join(mainPath, ".mysql.env"),
        `MYSQL_ROOT_PASSWORD=${password}\nMYSQL_DATABASE=workspace_verify\n`,
        { mode: 0o600 },
      );
      const mysqlTarget = workspaceTargetSchema.parse({
        ...target,
        environmentId: "mysql",
        profile: {
          enabled: true,
          app: {
            name: "app",
            image: "alpine:3.23",
            command: ["sleep", "infinity"],
            memoryMiB: 256,
          },
          services: [databasePreset("mysql", ".mysql.env")],
        },
      });
      targets.push(mysqlTarget);
      const mysql = await workspaceRuntime(
        mysqlTarget,
        "ensure",
        directory,
        runner,
      );
      const mysqlId = mysql.services.find((v) => v.name === "database")!.id;
      const inserted = await runner(
        [
          "exec",
          mysqlId,
          "sh",
          "-c",
          'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -h127.0.0.1 -uroot -D workspace_verify -Nse "CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES (\'mysql-persistent-proof\');"',
        ],
        30_000,
      );
      expect(inserted.ok, inserted.stderr).toBe(true);
      const mysqlRestored = await workspaceRuntime(
        mysqlTarget,
        "recreate",
        directory,
        runner,
      );
      const mysqlQuery = await runner(
        [
          "exec",
          mysqlRestored.services.find((v) => v.name === "database")!.id,
          "sh",
          "-c",
          'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -h127.0.0.1 -uroot -D workspace_verify -Nse "SELECT value FROM proof"',
        ],
        30_000,
      );
      expect(mysqlQuery.stdout.trim(), mysqlQuery.stderr).toBe(
        "mysql-persistent-proof",
      );
    } catch (error) {
      const diagnostics: string[] = [];
      const state = await snapshot(
        { binaryPath: "/opt/homebrew/bin/container", allowExternal: false },
        runner,
      );
      for (const target of targets) {
        const prefix = `bb-ws-${workspaceKey(target)}`;
        for (const item of state.containers.filter((v) =>
          v.id.startsWith(`${prefix}-`),
        )) {
          const logs = await runner(["logs", "-n", "30", item.id], 10_000);
          diagnostics.push(`${item.id}:\n${logs.stdout}\n${logs.stderr}`);
        }
      }
      primary = new Error(
        `${error instanceof Error ? error.message : String(error)}\n${diagnostics.join("\n")}`.replaceAll(
          password,
          "[redacted]",
        ),
      );
    } finally {
      // These identities belong only to this test, including partially completed launches.
      const failures: string[] = [];
      const existing = await snapshot(
        { binaryPath: "/opt/homebrew/bin/container", allowExternal: false },
        runner,
      );
      if (existing.warnings.length) failures.push(...existing.warnings);
      for (const item of targets) {
        const prefix = `bb-ws-${workspaceKey(item)}`;
        for (const name of ["app", "database"]) {
          if (!existing.containers.some((v) => v.id === `${prefix}-${name}`))
            continue;
          await runner(["stop", `${prefix}-${name}`], 60_000);
          const removed = await runner(["delete", `${prefix}-${name}`], 60_000);
          if (!removed.ok && !/not found|does not exist/i.test(removed.stderr))
            failures.push(removed.stderr);
        }
        if (existing.volumes.includes(`${prefix}-database-data`)) {
          const volume = await runner(
            ["volume", "delete", `${prefix}-database-data`],
            60_000,
          );
          if (!volume.ok) failures.push(volume.stderr);
        }
        if (existing.networks.includes(prefix)) {
          const network = await runner(["network", "delete", prefix], 60_000);
          if (!network.ok) failures.push(network.stderr);
        }
      }
      await rm(directory, { recursive: true, force: true });
      if (failures.length)
        throw new AggregateError(
          [...(primary ? [primary] : []), ...failures],
          "Disposable runtime cleanup failed",
        );
    }
    if (primary) throw primary;
  },
  600_000,
);
