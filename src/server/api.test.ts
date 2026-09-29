import { describe, expect, test } from "bun:test";
import { api } from "./api";

const check = (body: unknown) =>
  api.request("/api/workspace-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("workspace configuration boundary", () => {
  test("normalizes a clone URL but does not claim the repo exists or launch an agent", async () => {
    const response = await check({
      repository: " https://github.com/acme/widgets.git/ ",
      agent: "codex",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repository: "https://github.com/acme/widgets",
      agent: "codex",
      command: "codex",
      execution: "not-connected",
    });
  });

  test.each([
    "https://github.com.evil.test/acme/widgets",
    "https://token@github.com/acme/widgets",
    "https://github.com/acme/widgets/tree/main",
    "https://github.com/acme/widgets?token=secret",
    "https://github.com/acme/../widgets",
    "https://github.com/acme/%2e%2e",
    "https://github.com/acme/widgets\n--upload-pack=evil",
    "file:///etc/passwd",
  ])("rejects unsafe or ambiguous repository input: %s", async (repository) => {
    expect((await check({ repository, agent: "claude" })).status).toBe(400);
  });

  test("does not accept client-supplied commands or agent executables", async () => {
    const repository = "https://github.com/acme/widgets";
    expect(
      (await check({ repository, agent: "claude; curl evil.test" })).status,
    ).toBe(400);
    expect(
      (await check({ repository, agent: "claude", command: "rm -rf /" }))
        .status,
    ).toBe(400);
    const valid = await check({ repository, agent: "claude" });
    expect((await valid.json()).command).toBe("claude");
  });

  test("malformed and oversized bodies fail at the HTTP boundary", async () => {
    expect(
      (
        await api.request("/api/workspace-config", {
          method: "POST",
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (await check({ repository: "a".repeat(5000), agent: "codex" })).status,
    ).toBe(413);
  });
});
