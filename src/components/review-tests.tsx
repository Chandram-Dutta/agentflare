"use client";

import { useRef, useState } from "react";
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
  return (
    <details className="shrink-0 border-b px-3 py-2 text-xs">
      <summary className="cursor-pointer">
        Tests: {pending ? "running…" : (state ?? "not recorded")} · CI: not
        fetched
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-muted-foreground">
          Run this repository’s <code>bun run test</code> script in the
          workspace (60 second / 128 KiB limit). This executes repository code.
          No CI is triggered. Other test commands are not captured here.
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
                await apiRequest<ReviewTestResult>(`${base}/test`, "POST", {
                  revision: review.revision,
                }),
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
              Tested tree: <code>{result.revision}</code> · {result.finishedAt}
            </p>
            {state === "stale" && (
              <p role="alert">
                This result does not verify the current tree. Files changed
                during or after the run; rerun tests.
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
        ) : (
          <p className="text-muted-foreground">
            After publishing a draft PR, inspect its checks on GitHub. Local
            tests do not establish CI status.
          </p>
        )}
      </div>
    </details>
  );
}
