import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthCheckpoint } from "./auth-checkpoint.mjs";

test("checkpoint retries failures, skips partial writes, persists rotations and clears logout", async () => {
  const root = await mkdtemp(join(tmpdir(), "auth-checkpoint-"));
  const path = join(root, "auth.json");
  const values = [];
  let fail = true;
  await writeFile(path, '{"tokens":{"refresh_token":"first"}}');
  const checkpoint = createAuthCheckpoint({ path, url: "https://test.invalid/checkpoint", token: "synthetic", fetcher: async (_, init) => {
    expect(init.headers.Authorization).toBe("Bearer synthetic");
    if (fail) return new Response(null,{status:503});
    values.push(JSON.parse(init.body).credentials);
    return new Response(null,{status:204});
  } });
  checkpoint.stop();
  try {
    await expect(checkpoint.sync()).rejects.toThrow();
    fail = false;
    await checkpoint.sync();
    await checkpoint.sync();
    expect(values).toEqual(['{"tokens":{"refresh_token":"first"}}']);
    await writeFile(path, '{"tokens":');
    await expect(checkpoint.sync()).rejects.toThrow();
    expect(values).toHaveLength(1);
    await writeFile(path, '{"tokens":{"refresh_token":"rotated"}}');
    await checkpoint.sync();
    await rm(path);
    await checkpoint.sync();
    expect(values).toEqual(['{"tokens":{"refresh_token":"first"}}', '{"tokens":{"refresh_token":"rotated"}}', null]);
  } finally { checkpoint.stop(); await rm(root,{recursive:true,force:true}); }
});
