import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { repositoryCloneToken } from "./github";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const env = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
};
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
afterEach(() => fetchSpy?.mockRestore());

test("clone credentials require user access, then mint a signed repository-only read token", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ id: 987 }))
    .mockResolvedValueOnce(Response.json({ id: 456 }))
    .mockResolvedValueOnce(Response.json({ token: "installation-token" }));
  expect(
    await repositoryCloneToken(
      env,
      "https://github.com/owner/repo",
      "user-token",
    ),
  ).toBe("installation-token");
  const calls = fetchSpy.mock.calls.map(([url, init]) => ({
    url: String(url),
    init,
  }));
  expect(calls.map((c) => c.url)).toEqual([
    "https://api.github.com/repos/owner/repo",
    "https://api.github.com/repos/owner/repo/installation",
    "https://api.github.com/app/installations/456/access_tokens",
  ]);
  expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(
    "Bearer user-token",
  );
  expect(JSON.parse(calls[2].init?.body as string)).toEqual({
    repository_ids: [987],
    permissions: { contents: "read" },
  });
  const jwt = new Headers(calls[1].init?.headers)
    .get("Authorization")!
    .slice(7)
    .split(".");
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${jwt[0]}.${jwt[1]}`),
      publicKey,
      Buffer.from(jwt[2], "base64url"),
    ),
  ).toBe(true);
});

test("denied user access stops before using App authority", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("not found", { status: 404 }),
  );
  await expect(
    repositoryCloneToken(env, "https://github.com/owner/private", "user-token"),
  ).rejects.toThrow("GitHub denied repository access");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
