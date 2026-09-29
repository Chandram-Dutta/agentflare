import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
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

test("Workers can mint clone credentials and reject redirects without forwarding tokens", async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("./github.ts", import.meta.url).pathname],
    target: "node",
    external: ["node:crypto"],
  });
  expect(bundle.success).toBe(true);
  const requests: string[] = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: "2026-09-29",
      compatibilityFlags: ["nodejs_compat"],
      modules: [
        {
          type: "ESModule",
          path: "worker.js",
          contents: `import { repositoryCloneToken } from './github.js';
        export default { async fetch(request, env) {
          try {
            return new Response(await repositoryCloneToken(env,
              'https://github.com/owner/' + new URL(request.url).pathname.slice(1),
              'fixture-user-token'));
          } catch (error) {
            return new Response(error.message, { status: error.status ?? 500 });
          }
        } };`,
        },
        {
          type: "ESModule",
          path: "github.js",
          contents: await bundle.outputs[0].text(),
        },
      ],
      bindings: env,
      outboundService: async (request) => {
        requests.push(request.url);
        const path = new URL(request.url).pathname;
        if (path === "/repos/owner/redirect")
          return new Response(null, {
            status: 302,
            headers: { Location: "https://other.example/credentials" },
          });
        if (path === "/repos/owner/repo") return Response.json({ id: 987 });
        if (path === "/repos/owner/repo/installation")
          return Response.json({ id: 456 });
        if (path === "/app/installations/456/access_tokens")
          return Response.json({ token: "fixture-installation-token" });
        throw new Error("Unexpected outbound request");
      },
    }),
  );
  try {
    const success = await mf.dispatchFetch("http://worker/repo");
    expect(await success.text()).toBe("fixture-installation-token");
    expect(success.status).toBe(200);
    const redirect = await mf.dispatchFetch("http://worker/redirect");
    expect(redirect.status).toBe(502);
    expect(requests).toEqual([
      "https://api.github.com/repos/owner/repo",
      "https://api.github.com/repos/owner/repo/installation",
      "https://api.github.com/app/installations/456/access_tokens",
      "https://api.github.com/repos/owner/redirect",
    ]);
  } finally {
    await mf.dispose();
  }
}, 30000);
