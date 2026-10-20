import {
  workspaceProfileSchema,
  workspaceServiceSchema,
} from "./workspace-schema";

export const defaultWorkspaceProfile = () =>
  workspaceProfileSchema.parse({
    enabled: false,
    autoStart: true,
    app: {
      name: "app",
      image: "node:22-bookworm",
      command: ["sleep", "infinity"],
      ports: [3000],
      volumes: [{ name: "dependencies", target: "/workspace/node_modules" }],
    },
  });

export const databasePreset = (
  database: "postgres" | "mysql",
  envFile: string,
) =>
  workspaceServiceSchema.parse({
    name: "database",
    image: database === "mysql" ? "mysql:8.4" : "postgres:17",
    command:
      database === "mysql"
        ? ["mysqld", "--datadir=/var/lib/mysql/data"]
        : [
            "sh",
            "-c",
            "export PGDATA=/var/lib/postgresql/data/pgdata; exec docker-entrypoint.sh postgres",
          ],
    envFile,
    ports: [database === "mysql" ? 3306 : 5432],
    ready:
      database === "mysql"
        ? ["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]
        : ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
    volumes: [
      {
        name: "data",
        target:
          database === "mysql" ? "/var/lib/mysql" : "/var/lib/postgresql/data",
      },
    ],
  });
