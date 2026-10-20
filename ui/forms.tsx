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
import { parseCommand } from "../lib/argv";
import { errorMessage } from "./use-runtime";
import { Symbol } from "./elements";

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
  const [name, setName] = useState(""),
    [image, setImage] = useState(initialImage),
    [command, setCommand] = useState("sleep infinity");
  const [cpus, setCpus] = useState("2"),
    [memory, setMemory] = useState("1024"),
    [source, setSource] = useState(""),
    [target, setTarget] = useState("/workspace"),
    [port, setPort] = useState(""),
    [env, setEnv] = useState(""),
    [workdir, setWorkdir] = useState(""),
    [error, setError] = useState("");
  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      let ports: { host: number; guest: number }[] = [];
      if (port.trim()) {
        const parts = port.split(":");
        if (parts.length !== 2)
          throw new Error("Use host:guest for ports, for example 8080:80.");
        ports = [{ host: Number(parts[0]), guest: Number(parts[1]) }];
      }
      if (
        await submit({
          op: "run",
          name: name.trim(),
          image: image.trim(),
          command: parseCommand(command),
          cpus: Number(cpus),
          memoryMiB: Number(memory),
          env: env
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean),
          ports,
          mounts: source.trim()
            ? [{ source: source.trim(), target: target.trim(), readOnly: true }]
            : [],
          ...(workdir ? { workdir } : {}),
        })
      )
        close();
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
      <DialogContent className="ac-dialog sm:max-w-[590px] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <div className="ac-form-icon">
            <Symbol name="cube" size={26} />
          </div>
          <DialogTitle>New container</DialogTitle>
          <DialogDescription>
            Start a Linux workspace on your selected Mac.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={create} aria-label="New container" className="ac-form">
          <div className="ac-form-row">
            <label>
              Name
              <Input
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-workspace"
              />
            </label>
            <label>
              Image
              <Input
                required
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="alpine:3.23"
              />
            </label>
          </div>
          <label>
            Command
            <Input
              aria-label="Container command"
              className="ac-mono"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Image default command"
            />
            <small>
              Leave empty to use the image’s default. Quotes group arguments.
            </small>
          </label>
          <div className="ac-form-group">
            <h3>Resources</h3>
            <div className="ac-form-row">
              <label>
                CPUs
                <Input
                  type="number"
                  min={1}
                  max={32}
                  value={cpus}
                  onChange={(e) => setCpus(e.target.value)}
                  required
                />
              </label>
              <label>
                Memory (MiB)
                <Input
                  type="number"
                  min={128}
                  max={65536}
                  value={memory}
                  onChange={(e) => setMemory(e.target.value)}
                  required
                />
              </label>
            </div>
          </div>
          <details className="ac-advanced">
            <summary>Ports, folders & environment</summary>
            <div className="ac-form-row">
              <label>
                Port mapping
                <Input
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="8080:80"
                />
                <small>Host:guest, bound to 127.0.0.1.</small>
              </label>
              <label>
                Working directory
                <Input
                  value={workdir}
                  onChange={(e) => setWorkdir(e.target.value)}
                  placeholder="/workspace"
                />
              </label>
              <label>
                Mac folder (read-only)
                <Input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="/absolute/project/path"
                />
              </label>
              <label>
                Container folder
                <Input
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </label>
            </div>
            <label>
              Environment variables
              <textarea
                className="ac-textarea ac-mono"
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                placeholder={"NODE_ENV=development\nPORT=8080"}
                rows={3}
              />
              <small>One KEY=value per line.</small>
            </label>
          </details>
          {error && (
            <p role="alert" className="ac-error">
              {error}
            </p>
          )}
          <div className="ac-form-footer">
            <span>
              <Symbol name="shield" size={14} /> Managed by BB
            </span>
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
          <div className="ac-form-icon">
            <Symbol name={mode === "pull" ? "images" : "build"} size={26} />
          </div>
          <DialogTitle>
            {mode === "pull" ? "Pull image" : "Build image"}
          </DialogTitle>
          <DialogDescription>
            {mode === "pull"
              ? "Download an OCI image to your Mac’s local image library."
              : "Build a Dockerfile from a folder on your selected Mac."}
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
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                />
              </label>
              <label>
                Dockerfile (optional)
                <Input
                  placeholder="/absolute/project/path/Dockerfile"
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
