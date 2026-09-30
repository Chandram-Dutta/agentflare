import { z } from "zod";
import { github } from "./github";
import {
  repositoryPath,
  type PublishInput,
  type PublishResult,
} from "@/lib/runtime";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const snapshotSchema = z.object({
  revision: sha,
  branch: z.string(),
  entries: z
    .array(
      z.object({
        path: z.string().refine((value) => {
          try {
            repositoryPath(value);
            return true;
          } catch {
            return false;
          }
        }),
        mode: z.enum(["100644", "100755", "120000", "160000"]),
        type: z.enum(["blob", "commit"]),
        sha,
      }),
    )
    .max(10000),
  blobs: z.record(sha, z.string().max(6 * 1024 * 1024)),
});

export type PreparedPublish = { revision: string; sha: string; parent: string };
export type PublishState = {
  head?: string;
  prepared?: PreparedPublish;
  result?: PublishResult;
};

// Runs in the Worker/DO, never inside the agent container. No GitHub write
// credentials are passed to repository code, commands, hooks, or environment.
export async function publishSnapshot(
  input: PublishInput & {
    repository: string;
    branch: string;
    baseBranch: string;
    baseSha: string;
    token: string;
    snapshot: unknown;
    state: PublishState;
    save: (state: PublishState) => Promise<void>;
  },
): Promise<PublishResult> {
  const snapshot = snapshotSchema.parse(input.snapshot);
  if (snapshot.revision !== input.revision || snapshot.branch !== input.branch)
    throw Error(
      "The checkout changed. Review the latest changes before publishing.",
    );
  const path = input.repository.slice("https://github.com/".length);
  const root = `/repos/${path}`;
  const refPath = `${root}/git/ref/heads/${input.branch}`;
  const state = { ...input.state };
  const prs = (await github(
    `${root}/pulls?state=all&head=${encodeURIComponent(path.split("/")[0] + ":" + input.branch)}&per_page=100`,
    input.token,
  )) as {
    number: number;
    html_url: string;
    state: string;
    base: { ref: string };
  }[];
  if (prs.some((pr) => pr.state !== "open" || pr.base.ref !== input.baseBranch))
    throw Error(
      "This branch has a closed PR or a different PR base. Start a new thread.",
    );
  const ref = (await github(refPath, input.token, undefined, "GET", true)) as {
    object: { sha: string };
  } | null;
  let head = ref?.object.sha;
  // Recover an uncertain ref-write response using the persisted intent, not a
  // guessed branch name. Never adopt an unrelated existing remote branch.
  if (head && head === state.prepared?.sha) {
    state.head = head;
    await input.save(state);
  }
  if ((head && head !== state.head) || (!head && state.head))
    throw Error(
      "The remote thread branch changed outside Agentflare. Publishing stopped; no force push was attempted.",
    );
  const parent = head ?? input.baseSha;
  const commit = (await github(
    `${root}/git/commits/${parent}`,
    input.token,
  )) as { tree: { sha: string } };
  if (!head || commit.tree.sha !== snapshot.revision) {
    let prepared = state.prepared;
    if (
      !prepared ||
      prepared.revision !== snapshot.revision ||
      prepared.parent !== parent
    ) {
      let total = 0;
      for (const [expected, content] of Object.entries(snapshot.blobs)) {
        total += content.length;
        if (total > 6 * 1024 * 1024)
          throw Error("Publish exceeds 4 MiB of changed content.");
        const blob = (await github(`${root}/git/blobs`, input.token, {
          encoding: "base64",
          content,
        })) as { sha: string };
        if (blob.sha !== expected)
          throw Error("Snapshot blob verification failed.");
      }
      const tree = (await github(`${root}/git/trees`, input.token, {
        tree: snapshot.entries,
      })) as { sha: string };
      if (tree.sha !== snapshot.revision)
        throw Error("Snapshot tree verification failed.");
      const next = (await github(`${root}/git/commits`, input.token, {
        message: input.title,
        tree: tree.sha,
        parents: [parent],
      })) as { sha: string };
      prepared = { revision: snapshot.revision, sha: next.sha, parent };
      state.prepared = prepared;
      await input.save(state);
    }
    if (head) {
      await github(
        `${root}/git/refs/heads/${input.branch}`,
        input.token,
        { sha: prepared.sha, force: false },
        "PATCH",
      );
    } else {
      await github(`${root}/git/refs`, input.token, {
        ref: `refs/heads/${input.branch}`,
        sha: prepared.sha,
      });
    }
    head = prepared.sha;
    state.head = head;
    await input.save(state);
  }
  const pr =
    prs[0] ??
    ((await github(`${root}/pulls`, input.token, {
      title: input.title,
      body: input.body,
      head: input.branch,
      base: input.baseBranch,
      draft: true,
    })) as { number: number; html_url: string });
  const result = { sha: head!, url: pr.html_url, number: pr.number };
  state.result = result;
  await input.save(state);
  return result;
}
