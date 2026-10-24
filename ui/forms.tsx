import { useState, type FormEvent } from "react";
import type { ContainerCommand } from "../contract";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
import { formatCommandLines, parseCommand } from "../lib/argv";
import { runArgs, type RunCommand } from "../lib/run-args";
import { errorMessage } from "./use-runtime";
import { formatBytes, Symbol } from "./elements";

type RunFields = {
  name: string;
  image: string;
  command: string;
  cpus: string;
  memory: string;
  source: string;
  target: string;
  port: string;
  env: string;
  workdir: string;
};
/** The single translation from form fields to the run command, shared by the
 * preview and submission so the preview is exactly what will run. */
function draftRun(f: RunFields): RunCommand {
  let ports: { host: number; guest: number }[] = [];
  if (f.port.trim()) {
    const parts = f.port.split(":");
    if (parts.length !== 2)
      throw new Error("Use host:guest for ports, for example 8080:80.");
    ports = [{ host: Number(parts[0]), guest: Number(parts[1]) }];
  }
  return {
    op: "run",
    name: f.name.trim(),
    image: f.image.trim(),
    command: parseCommand(f.command),
    cpus: Number(f.cpus),
    memoryMiB: Number(f.memory),
    env: f.env
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean),
    ports,
    mounts: f.source.trim()
      ? [{ source: f.source.trim(), target: f.target.trim(), readOnly: true }]
      : [],
    ...(f.workdir ? { workdir: f.workdir } : {}),
  };
}
function CommandPreview({ fields }: { fields: RunFields }) {
  const [copied, setCopied] = useState(false);
  let line = "";
  try {
    const draft = draftRun(fields);
    line = formatCommandLines(
      [
        "container",
        ...runArgs({
          ...draft,
          name: draft.name || "NAME",
          image: draft.image || "IMAGE",
        }),
      ],
      ["run", "--detach"],
    );
  } catch {
    /* Submission reports the problem; the preview just waits. */
  }
  return (
    <section className="ac-preview" aria-label="Command preview">
      <div className="ac-preview-heading">
        <span>Runs on the selected Mac as</span>
        <button
          type="button"
          className="ac-preview-copy"
          disabled={!line}
          onClick={() => {
            void navigator.clipboard?.writeText(line).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{line || "Finish the fields above to see the command."}</pre>
    </section>
  );
}
export function CreateDialog({
  open,
  close,
  busy,
  submit,
  image: initialImage = "alpine:3.23",
}: {
  open: boolean;
  close: () => void;
  busy: boolean;
  submit: (command: ContainerCommand) => Promise<boolean>;
  image?: string;
}) {
  const [fields, setFields] = useState<RunFields>({
    name: "",
    image: initialImage,
    command: "sleep infinity",
    cpus: "2",
    memory: "1024",
    source: "",
    target: "/workspace",
    port: "",
    env: "",
    workdir: "",
  });
  const [error, setError] = useState("");
  const field = (key: keyof RunFields) => ({
    value: fields[key],
    onChange: (e: { target: { value: string } }) => {
      // Read now: React restores a controlled input before a lazy updater runs.
      const value = e.target.value;
      setFields((current) => ({ ...current, [key]: value }));
    },
  });
  const memoryBytes = Number(fields.memory) * 1024 * 1024;
  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      if (await submit(draftRun(fields))) close();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) close();
      }}
    >
      <DialogContent className="ac-dialog sm:max-w-[620px] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New container</DialogTitle>
          <DialogDescription>
            Starts a detached Linux container on the selected Mac. BB labels it
            so agents can manage it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={create} aria-label="New container" className="ac-form">
          <div className="ac-form-row">
            <label>
              Name
              <Input
                required
                autoFocus
                placeholder="my-workspace"
                className="ac-mono"
                {...field("name")}
              />
            </label>
            <label>
              Image
              <Input
                required
                placeholder="alpine:3.23"
                className="ac-mono"
                {...field("image")}
              />
            </label>
          </div>
          <label>
            Command
            <Input
              aria-label="Container command"
              className="ac-mono"
              placeholder="Image default command"
              {...field("command")}
            />
            <small>
              Leave empty to use the image’s default. Quotes group arguments.
            </small>
          </label>
          <div className="ac-form-row">
            <label>
              CPUs
              <Input
                type="number"
                min={1}
                max={32}
                required
                {...field("cpus")}
              />
            </label>
            <label>
              <span className="ac-label-row">
                Memory (MiB)
                <small>
                  {memoryBytes >= 1
                    ? formatBytes(memoryBytes)
                    : "200 MiB minimum"}
                </small>
              </span>
              <Input
                type="number"
                min={200}
                max={65536}
                required
                {...field("memory")}
              />
            </label>
          </div>
          <details className="ac-advanced">
            <summary>Ports, folders and environment</summary>
            <div className="ac-form-row">
              <label>
                Port mapping
                <Input
                  placeholder="8080:80"
                  className="ac-mono"
                  {...field("port")}
                />
                <small>Mac port:container port, on 127.0.0.1 only.</small>
              </label>
              <label>
                Working directory
                <Input
                  placeholder="/workspace"
                  className="ac-mono"
                  {...field("workdir")}
                />
              </label>
              <label>
                Mac folder (read-only)
                <Input
                  placeholder="/absolute/project/path"
                  className="ac-mono"
                  {...field("source")}
                />
              </label>
              <label>
                Container folder
                <Input className="ac-mono" {...field("target")} />
              </label>
            </div>
            <label>
              Environment variables
              <textarea
                className="ac-textarea ac-mono"
                placeholder={"NODE_ENV=development\nPORT=8080"}
                rows={3}
                {...field("env")}
              />
              <small>One KEY=value per line.</small>
            </label>
          </details>
          <CommandPreview fields={fields} />
          {error && (
            <p role="alert" className="ac-error">
              {error}
            </p>
          )}
          <div className="ac-form-footer">
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" className="ac-primary" disabled={busy}>
              <Symbol name="play" size={14} />
              {busy ? "Creating…" : "Create container"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function ImageDialog({
  mode,
  close,
  busy,
  submit,
}: {
  mode: "pull" | "build";
  close: () => void;
  busy: boolean;
  submit: (command: ContainerCommand) => Promise<boolean>;
}) {
  const [image, setImage] = useState(""),
    [context, setContext] = useState(""),
    [file, setFile] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) close();
      }}
    >
      <DialogContent className="ac-dialog sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {mode === "pull" ? "Pull image" : "Build image"}
          </DialogTitle>
          <DialogDescription>
            {mode === "pull"
              ? "Downloads an OCI image into the selected Mac’s image library."
              : "Builds a Dockerfile from a folder on the selected Mac."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="ac-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await submit(
                mode === "pull"
                  ? { op: "pull", image: image.trim() }
                  : {
                      op: "build",
                      tag: image.trim(),
                      context: context.trim(),
                      ...(file.trim() ? { file: file.trim() } : {}),
                    },
              )
            )
              close();
          }}
        >
          <label>
            {mode === "pull" ? "Image reference" : "Image tag"}
            <Input
              autoFocus
              required
              className="ac-mono"
              placeholder={
                mode === "pull" ? "docker.io/library/alpine:3.23" : "my-app:dev"
              }
              value={image}
              onChange={(e) => setImage(e.target.value)}
            />
          </label>
          {mode === "build" && (
            <>
              <label>
                Build folder
                <Input
                  required
                  placeholder="/absolute/project/path"
                  className="ac-mono"
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                />
              </label>
              <label>
                Dockerfile (optional)
                <Input
                  placeholder="/absolute/project/path/Dockerfile"
                  className="ac-mono"
                  value={file}
                  onChange={(e) => setFile(e.target.value)}
                />
              </label>
            </>
          )}
          <div className="ac-form-footer">
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" className="ac-primary" disabled={busy}>
              {busy
                ? "Working…"
                : mode === "pull"
                  ? "Pull image"
                  : "Build image"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
