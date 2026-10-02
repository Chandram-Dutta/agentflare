import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  readlink,
  chmod,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createWorkspaceArchive } from "./workspace-archive.mjs";

test("fingerprints include ignored files, rollouts, bytes, modes, links and empty directories without creating an archive", async () => {
  const temp = await mkdtemp(join(tmpdir(), "computer-fingerprint-"));
  const root = join(temp, "workspace");
  try {
    await mkdir(join(root, ".codex/sessions"), { recursive: true });
    await mkdir(join(root, "repo"));
    const source = join(root, "repo/ignored.bin");
    await writeFile(source, "aaaa");
    await writeFile(join(root, "repo/.gitignore"), "ignored.bin");
    await writeFile(join(root, ".codex/sessions/rollout.jsonl"), "session-one");
    await writeFile(join(temp, "credential"), "secret-one");
    await symlink("../credential", join(root, "link"));
    const handle = createWorkspaceArchive(root, join(temp, "archive"));
    const fingerprint = async () => {
      const response = await handle(
        new Request("http://test/", { method: "HEAD" }),
      );
      expect(response.status).toBe(200);
      const hash = response.headers.get("X-Workspace-Fingerprint");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      return hash;
    };
    let previous = await fingerprint();
    expect(await fingerprint()).toBe(previous);
    expect(
      await Bun.file(join(temp, "archive/workspace.tar.gz")).exists(),
    ).toBe(false);
    // Follow neither credential symlinks nor their external file contents.
    await writeFile(join(temp, "credential"), "secret-two");
    expect(await fingerprint()).toBe(previous);
    const before = await stat(source);
    for (const mutate of [
      async () => {
        await writeFile(source, "bbbb"); // same size, restored mtime: bytes must win
        await utimes(source, before.atime, before.mtime);
      },
      () => chmod(source, 0o755),
      () =>
        writeFile(join(root, ".codex/sessions/rollout.jsonl"), "session-two"),
      async () => {
        await rm(join(root, "link"));
        await symlink("../different", join(root, "link"));
      },
      () => mkdir(join(root, "empty")),
      () => rm(join(root, "empty"), { recursive: true }),
    ]) {
      await mutate();
      const next = await fingerprint();
      expect(next).not.toBe(previous);
      expect(await fingerprint()).toBe(next);
      previous = next;
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("archive restores exact code, Git state and rollouts without copying external credentials", async () => {
  const temp = await mkdtemp(join(tmpdir(), "computer-archive-"));
  const root = join(temp, "workspace");
  try {
    await mkdir(join(root, "threads/one/repo/.git"), { recursive: true });
    await mkdir(join(root, ".codex/sessions"), { recursive: true });
    const binary = randomBytes(2_200_000);
    await writeFile(join(root, "threads/one/repo/file.bin"), binary);
    await writeFile(join(root, "threads/one/repo/.git/index"), "staged-state");
    await writeFile(
      join(root, ".codex/sessions/rollout.jsonl"),
      '{"session":"saved"}\n',
    );
    await writeFile(join(temp, "auth.json"), "synthetic-secret");
    await symlink("../auth.json", join(root, "auth-link"));
    const handle = createWorkspaceArchive(root, join(temp, "archive"));
    const captured = await handle(new Request("http://test/"));
    expect(captured.status).toBe(200);
    const archive = await captured.arrayBuffer();
    await writeFile(join(root, "threads/one/repo/file.bin"), "newer-source");
    await writeFile(join(root, "discarded.txt"), "not-in-checkpoint");
    const restored = await handle(
      new Request("http://test/", { method: "POST", body: archive }),
    );
    expect(restored.status).toBe(204);
    expect(await readFile(join(root, "threads/one/repo/file.bin"))).toEqual(
      binary,
    );
    expect(
      await readFile(join(root, "threads/one/repo/.git/index"), "utf8"),
    ).toBe("staged-state");
    expect(
      await readFile(join(root, ".codex/sessions/rollout.jsonl"), "utf8"),
    ).toBe('{"session":"saved"}\n');
    expect(await Bun.file(join(root, "discarded.txt")).exists()).toBe(false);
    expect(await readlink(join(root, "auth-link"))).toBe("../auth.json");
    expect(await readFile(join(temp, "auth.json"), "utf8")).toBe(
      "synthetic-secret",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("invalid restore preserves live files and overlapping archive operations are refused", async () => {
  const temp = await mkdtemp(join(tmpdir(), "computer-archive-"));
  const root = join(temp, "workspace");
  try {
    await mkdir(root);
    await writeFile(join(root, "source"), "must-survive");
    const handle = createWorkspaceArchive(root, join(temp, "archive"));
    expect(
      (
        await handle(
          new Request("http://test/", {
            method: "POST",
            body: "not a tarball",
          }),
        )
      ).status,
    ).toBe(500);
    expect(await readFile(join(root, "source"), "utf8")).toBe("must-survive");
    const pending = handle(new Request("http://test/"));
    expect((await handle(new Request("http://test/"))).status).toBe(409);
    expect((await pending).status).toBe(200);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
