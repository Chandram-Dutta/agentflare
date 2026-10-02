import { describe, expect, test } from "bun:test";
import { WorkspacePersistence } from "./workspace-persistence";
import { ThreadStateStore } from "./thread-state";

function storage(): Storage {
  const values: Record<string, string> = {};
  return new Proxy(values, {
    get(target, key) {
      if (key === "getItem") return (key: string) => target[key] ?? null;
      if (key === "setItem")
        return (key: string, value: string) => {
          target[key] = value;
        };
      if (key === "removeItem")
        return (key: string) => {
          delete target[key];
        };
      return target[key as string];
    },
  }) as unknown as Storage;
}
describe("workspace recovery", () => {
  test("review fingerprints and positions roundtrip without accepting patch text", () => {
    const local = storage(),
      session = storage();
    const persistence = new WorkspacePersistence(local, session, "alice");
    const review = { reviewed: { "src/a.ts": "a".repeat(64) } };
    persistence.patch("one", { review, reviewScrollTop: 920 });
    expect(persistence.read("one").review).toEqual(review);
    expect(persistence.read("one").reviewScrollTop).toBe(920);
    persistence.patch("one", {
      review: { reviewed: { "src/a.ts": "+sensitive source" } },
    });
    expect(JSON.stringify(local)).not.toContain("sensitive");
    expect(persistence.read("two").review).toBeUndefined();
  });
  test("fresh edits win over recovery and aggregate attachment limits are enforced", () => {
    const local = storage(),
      session = storage();
    session.setItem(
      "agentflare:workspace:v1:alice:one",
      JSON.stringify({ updated: Date.now(), draft: "stale" }),
    );
    session.setItem(
      "agentflare:workspace:v1:alice:two",
      JSON.stringify({
        updated: Date.now(),
        attachments: [
          { type: "image", mimeType: "image/png", data: "eA==".repeat(1) },
          { type: "image", mimeType: "image/png", data: "a".repeat(1_100_000) },
          { type: "image", mimeType: "image/png", data: "b".repeat(1_100_000) },
        ],
      }),
    );
    const persistence = new WorkspacePersistence(local, session, "alice");
    const store = new ThreadStateStore();
    store.update("one", { draft: "fresh" });
    persistence.connect(store, ["one", "two"]);
    expect(store.get("one").draft).toBe("fresh");
    expect(store.get("two").attachments).toEqual([]);
  });
  test("denied storage reports failures without crashing edits or logout", () => {
    const local = storage();
    const denied = new Proxy(storage(), {
      get(target, key) {
        if (["getItem", "setItem", "removeItem"].includes(String(key)))
          return () => {
            throw new DOMException("Denied", "SecurityError");
          };
        return Reflect.get(target, key);
      },
    });
    let warning = "";
    const persistence = new WorkspacePersistence(
      local,
      denied,
      "alice",
      (value) => {
        warning = value;
      },
    );
    const store = new ThreadStateStore();
    const stop = persistence.connect(store, ["one"]);
    store.update("one", { draft: "still editable" });
    expect(store.get("one").draft).toBe("still editable");
    expect(warning).toContain("unavailable");
    persistence.clear();
    stop();
  });
  test("reload recovers unsent text and attachment bytes, not into durable storage", () => {
    const local = storage(),
      session = storage();
    const persistence = new WorkspacePersistence(local, session, "alice");
    const store = new ThreadStateStore();
    const stop = persistence.connect(store, ["one"]);
    store.update("one", {
      draft: "unsent secret",
      attachments: [{ type: "image", mimeType: "image/png", data: "c2VjcmV0" }],
    });
    expect(JSON.stringify(local)).not.toContain("secret");
    const recovered = new ThreadStateStore();
    persistence.connect(recovered, ["one"]);
    expect(recovered.get("one").draft).toBe("unsent secret");
    expect(recovered.get("one").attachments).toEqual(
      store.get("one").attachments,
    );
    store.update("one", { draft: "", attachments: [] });
    stop();
    const sent = new ThreadStateStore();
    persistence.connect(sent, ["one"]);
    expect(sent.get("one").draft).toBe("");
    expect(sent.get("one").attachments).toEqual([]);
  });
  test("account changes purge old account; logout cannot resurrect data", () => {
    const local = storage(),
      session = storage();
    const alice = new WorkspacePersistence(local, session, "alice");
    const store = new ThreadStateStore();
    const stop = alice.connect(store, ["one"]);
    store.update("one", { draft: "Alice private" });
    alice.patch("one", { sidebar: false });
    const bob = new WorkspacePersistence(local, session, "bob");
    const other = new ThreadStateStore();
    bob.connect(other, ["one"]);
    expect(other.get("one").draft).toBe("");
    expect(bob.read("one").sidebar).toBeUndefined();
    bob.patch("one", { agent: false });
    alice.clear();
    stop();
    expect(bob.read("one").agent).toBe(false);
    expect(JSON.stringify(session)).not.toContain("Alice");
  });
  test("only authorized current threads hydrate; durable cache strips source", () => {
    const local = storage(),
      session = storage();
    const persistence = new WorkspacePersistence(local, session, "alice");
    const store = new ThreadStateStore();
    const stop = persistence.connect(store, ["one", "deleted"]);
    store.update("deleted", { draft: "gone" });
    store.update("one", {
      repository: {
        files: ["src/main.ts"],
        changes: [],
        tab: "files",
        viewer: {
          paths: ["src/main.ts"],
          active: "src/main.ts",
          cache: {
            "src/main.ts": {
              path: "src/main.ts",
              content: "source secret",
              scrollTop: 417,
            },
          },
        },
      },
    });
    stop();
    persistence.connect(new ThreadStateStore(), ["one"]);
    expect(JSON.stringify(session)).not.toContain("gone");
    expect(JSON.stringify(local)).not.toContain("source secret");
    expect(
      persistence.read("one").repository?.viewer?.cache["src/main.ts"]
        .scrollTop,
    ).toBe(417);
  });
  test("corrupt metadata and expired drafts are discarded; quota is visible", () => {
    const local = storage(),
      session = storage();
    local.setItem(
      "agentflare:workspace:v1:alice:one",
      JSON.stringify({ updated: Date.now(), repository: { viewer: "broken" } }),
    );
    session.setItem(
      "agentflare:workspace:v1:alice:one",
      JSON.stringify({ updated: 1, draft: "expired" }),
    );
    const persistence = new WorkspacePersistence(local, session, "alice");
    expect(persistence.read("one")).toEqual({});
    const store = new ThreadStateStore();
    persistence.connect(store, ["one"]);
    expect(store.get("one").draft).toBe("");
    let warning = "";
    const full = new Proxy(local, {
      get(target, key) {
        if (key === "setItem")
          return () => {
            throw new DOMException("Full", "QuotaExceededError");
          };
        return Reflect.get(target, key);
      },
    });
    const limited = new WorkspacePersistence(
      full,
      session,
      "alice",
      (value) => {
        warning = value;
      },
    );
    limited.patch("one", { agent: false });
    expect(warning).toContain("full or unavailable");
    expect(local.getItem("agentflare:workspace:v1:alice:one")).toBeNull();
  });
});
