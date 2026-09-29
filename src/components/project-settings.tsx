"use client";

import { useState, type FormEvent } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apiRequest } from "@/lib/api-client";
import type { Project } from "@/lib/workspace";

export function ProjectSettings({
  project,
  onSave,
}: {
  project?: Project;
  onSave: (project: Project) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(project?.name ?? "");
  const [repository, setRepository] = useState(project?.repository ?? "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const id = project?.id ?? "new-project";

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const result = await apiRequest<Project>(
        project ? `/projects/${project.id}` : "/projects",
        project ? "PATCH" : "POST",
        { name, repository, ...(project ? { version: project.version } : {}) },
      );
      onSave(result);
      setOpen(false);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to save project.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (pending) return;
        setOpen(value);
        if (value) {
          setName(project?.name ?? "");
          setRepository(project?.repository ?? "");
          setError("");
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            className="h-8 shrink-0 rounded-none px-2 text-xs font-normal"
          />
        }
      >
        {project ? (
          <>
            <Settings2 className="size-3.5" />
            project settings
          </>
        ) : (
          "+ project"
        )}
      </DialogTrigger>
      <DialogContent className="rounded-none border bg-background text-foreground ring-0 sm:max-w-md">
        <DialogTitle className="text-sm font-normal">
          {project ? "project settings" : "new project"}
        </DialogTitle>
        <DialogDescription className="text-xs leading-5">
          Saved to this installation. Adding a repository does not clone it or
          grant access.
        </DialogDescription>
        <form onSubmit={save} className="space-y-5">
          <div className="space-y-2">
            <Label
              htmlFor={`${id}-name`}
              className="text-xs font-normal text-muted-foreground"
            >
              name
            </Label>
            <Input
              id={`${id}-name`}
              required
              value={name}
              maxLength={40}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
              className="workspace-input"
            />
          </div>
          <div className="space-y-2">
            <Label
              htmlFor={`${id}-repository`}
              className="text-xs font-normal text-muted-foreground"
            >
              repository
            </Label>
            <Input
              id={`${id}-repository`}
              required
              type="url"
              value={repository}
              maxLength={240}
              disabled={pending}
              onChange={(event) => setRepository(event.target.value)}
              placeholder="https://github.com/owner/repo"
              className="workspace-input"
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            className="h-8 rounded-none text-xs font-normal"
            disabled={pending}
          >
            {pending ? "saving…" : project ? "save changes" : "create project"}
          </Button>
          {error && (
            <p className="text-[11px] leading-5 text-destructive" role="alert">
              {error}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
