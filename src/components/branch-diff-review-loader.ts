import { apiRequest } from "../lib/api-client";

export type DiffResult =
  | { state: "loading" }
  | { state: "ready"; patch: string }
  | { state: "error"; message: string };

export function patchKind(patch: string) {
  if (!patch.trim()) return "empty";
  if (/^(Binary files .* differ|GIT binary patch)\r?$/m.test(patch))
    return "binary";
  if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(patch)) return "text";
  return "metadata";
}

// Retries share the same queue as initial loads, so they cannot exceed the cap.
export function loadBranchDiffs(
  base: string,
  paths: string[],
  onResult: (path: string, result: DiffResult) => void,
  request: (url: string, signal: AbortSignal) => Promise<unknown> = (
    url,
    signal,
  ) => apiRequest(url, "GET", undefined, signal),
) {
  const controller = new AbortController();
  const queue = [...new Set(paths)];
  const states = new Map<string, DiffResult["state"]>();
  let active = 0;
  function pump() {
    while (!controller.signal.aborted && active < 4 && queue.length) {
      const path = queue.shift()!;
      active++;
      states.set(path, "loading");
      onResult(path, { state: "loading" });
      void (async () => {
        try {
          const value = await request(
            `${base}/branch-diff?path=${encodeURIComponent(path)}`,
            controller.signal,
          );
          if (
            !value ||
            typeof value !== "object" ||
            !("patch" in value) ||
            typeof value.patch !== "string"
          )
            throw new Error("The server returned an invalid diff response.");
          if (!controller.signal.aborted) {
            states.set(path, "ready");
            onResult(path, { state: "ready", patch: value.patch });
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            states.set(path, "error");
            onResult(path, {
              state: "error",
              message:
                error instanceof Error ? error.message : "Could not load diff.",
            });
          }
        } finally {
          active--;
          pump();
        }
      })();
    }
  }
  pump();
  return {
    cancel: () => controller.abort(),
    retry(path: string) {
      if (controller.signal.aborted || states.get(path) !== "error") return;
      states.set(path, "loading");
      onResult(path, { state: "loading" });
      queue.push(path);
      pump();
    },
  };
}
