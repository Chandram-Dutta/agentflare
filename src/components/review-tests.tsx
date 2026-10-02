"use client";

import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  FlaskConical,
  LoaderCircle,
  CircleAlert,
  CircleCheck,
} from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { testResultState, type ReviewTestResult } from "../lib/review";
import type { BranchReview } from "../lib/runtime";

export function ReviewTests({
  base,
  review,
}: {
  base: string;
  review: BranchReview;
}) {
  const [result, setResult] = useState<ReviewTestResult>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const state = result ? testResultState(result, review.revision) : undefined;
  const label = pending
    ? "Tests running"
    : state
      ? `Tests: ${state}`
      : error
        ? "Tests unavailable"
        : "Run tests";
  const Icon = pending
    ? LoaderCircle
    : error || state === "failed" || state === "stale" || state === "incomplete"
      ? CircleAlert
      : state === "passed"
        ? CircleCheck
        : FlaskConical;
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        title={label}
        className="rounded p-1.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Icon
          aria-hidden="true"
          className={`size-3.5 ${pending ? "animate-spin" : state === "passed" ? "text-emerald-500" : error || state === "failed" ? "text-destructive" : ""}`}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="end"
          sideOffset={8}
          className="z-50"
        >
          <Popover.Popup className="w-96 max-w-[calc(100vw-24px)] max-h-[var(--available-height)] overflow-auto rounded-md border bg-background p-3 text-xs shadow-lg">
            <Popover.Title>
              {state ? `Tests · ${state}` : "Workspace tests"}
            </Popover.Title>
            <div className="mt-2 space-y-2">
              <p className="text-muted-foreground">
                Executes <code>bun run test</code> in this workspace. 60s / 128
                KiB limit. Not CI.
              </p>
              <button
                type="button"
                className="rounded border px-2 py-1.5 disabled:opacity-40"
                disabled={pending}
                onClick={async () => {
                  if (running.current) return;
                  running.current = true;
                  setPending(true);
                  setError("");
                  setResult(undefined);
                  try {
                    setResult(
                      await apiRequest<ReviewTestResult>(
                        `${base}/test`,
                        "POST",
                        {
                          revision: review.revision,
                        },
                      ),
                    );
                  } catch (error) {
                    setError(
                      error instanceof Error
                        ? error.message
                        : "Tests unavailable; no result recorded.",
                    );
                  } finally {
                    running.current = false;
                    setPending(false);
                  }
                }}
              >
                {pending ? "Running bun run test…" : "Run bun run test"}
              </button>
              {error && (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              )}
              {result && (
                <>
                  <p>
                    Command: <code>{result.command}</code> · Exit:{" "}
                    {result.exitCode ?? "unavailable / incomplete"}
                  </p>
                  <p className="break-all">
                    Tested tree: <code>{result.revision}</code> ·{" "}
                    {result.finishedAt}
                  </p>
                  {state === "stale" && (
                    <p role="alert">
                      This result does not verify the current tree. Files
                      changed during or after the run; rerun tests.
                    </p>
                  )}
                  <pre
                    aria-label="Captured test output"
                    className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2"
                  >
                    {result.output || "No output."}
                  </pre>
                </>
              )}
              {review.published ? (
                <a
                  className="underline"
                  href={`${review.published.url}/checks`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open PR checks on GitHub ↗ (last published commit{" "}
                  {review.published.sha.slice(0, 8)})
                </a>
              ) : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
