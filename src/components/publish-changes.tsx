"use client";

import { useState } from "react";
import { GitPullRequest, Upload } from "lucide-react";
import { Button } from "./ui/button";
import { toast } from "./ui/toast";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { apiRequest } from "@/lib/api-client";
import type { BranchReview, PublishResult } from "@/lib/runtime";

export function PublishChanges({
  base,
  review,
  onPublished,
}: {
  base: string;
  review: BranchReview;
  onPublished: () => void;
}) {
  const [target, setTarget] = useState<BranchReview>();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PublishResult>();
  const published = result ?? review.published;
  const stale = target && target.revision !== review.revision;
  async function publish() {
    if (!target || pending || stale || !confirmed) return;
    setPending(true);
    setError("");
    try {
      setResult(
        await apiRequest<PublishResult>(`${base}/publish`, "POST", {
          revision: target.revision,
          title,
          body,
        }),
      );
      setTarget(undefined);
      onPublished();
      toast.add({
        title: published
          ? "Pull request updated"
          : "Draft pull request created",
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Publishing failed.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="mb-3 space-y-2">
      {published && (
        <a
          className="block text-primary underline"
          href={published.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open PR #{published.number} ↗
        </a>
      )}
      {(review.changes.length > 0 || published) && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={published ? "Update PR" : "Create draft PR"}
          title={published ? "Update PR" : "Create draft PR"}
          disabled={!review.changes.length && !published}
          onClick={() => {
            setTarget(review);
            setError("");
            setConfirmed(false);
          }}
        >
          {published ? (
            <Upload className="size-4" />
          ) : (
            <GitPullRequest className="size-4" />
          )}
        </Button>
      )}
      <Dialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !pending) setTarget(undefined);
        }}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogTitle>
            {published ? "Publish an update" : "Create draft PR"}
          </DialogTitle>
          <DialogDescription>
            Publish all changed files as one snapshot commit, including files
            not marked reviewed. Local commits and staging stay unchanged; their
            history is not copied. No force push. Checks have not been verified
            by Agentflare.
          </DialogDescription>
          <p className="break-all text-xs">
            {target?.branch} → {target?.baseBranch}
          </p>
          <div
            className="max-h-36 overflow-auto border p-2 text-xs"
            aria-label="Files to publish"
          >
            {target?.changes.map((change) => (
              <div key={change.path}>
                {change.status} {change.path}
              </div>
            ))}
            {target?.changes.length === 0 && (
              <p>Restores the branch to its original base snapshot.</p>
            )}
          </div>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={pending || !!stale}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I reviewed this snapshot and want to publish all listed changes.
            This does not approve the PR or verify tests / CI.
          </label>
          <label className="flex flex-col gap-1.5 text-xs">
            {published ? "Commit message" : "PR title / commit message"}
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              disabled={pending}
              placeholder="Describe this change"
            />
          </label>
          {!published && (
            <label className="flex flex-col gap-1.5 text-xs">
              PR description
              <textarea
                className="block min-h-24 w-full border bg-background p-2"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={20000}
                disabled={pending}
              />
            </label>
          )}
          {stale && (
            <p role="alert" className="text-xs text-destructive">
              Files changed since this review opened. Close and review the
              latest changes.
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setTarget(undefined)}
            >
              Cancel
            </Button>
            <Button
              disabled={pending || !!stale || !title.trim() || !confirmed}
              onClick={() => void publish()}
            >
              {pending
                ? "Publishing…"
                : published
                  ? "Commit and update PR"
                  : "Commit, push & create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
