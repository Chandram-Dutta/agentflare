import { expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readAcpUpdate } from "../lib/acp-transport";
import type { TransportComputer } from "./__fixtures__/transport-worker";

test("Computer incremental reads survive bridge restart and never wake suspended containers or renew leases", async () => {
  const build = await Bun.build({
    entrypoints: [
      new URL("./__fixtures__/transport-worker.ts", import.meta.url).pathname,
    ],
    target: "browser",
    external: ["cloudflare:workers", "node:*"],
  });
  if (!build.success) throw new AggregateError(build.logs);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await build.outputs[0].text(),
      compatibilityDate: "2026-09-29",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        Test: { className: "TransportComputer", useSQLite: true },
      },
    }),
  );
  try {
    const response = await mf.dispatchFetch("http://test/");
    expect(response.status).toBe(200);
    const result = (await response.json()) as Awaited<
      ReturnType<TransportComputer["exercise"]>
    >;
    let cursor = readAcpUpdate(undefined, result.first);
    expect(readAcpUpdate(cursor, result.unchanged)).toBe(cursor);
    cursor = readAcpUpdate(cursor, result.changed);
    expect(cursor.snapshot.messages[0].text.endsWith(" updated")).toBe(true);
    expect(cursor.snapshot.permissions[0].id).toBe("p");
    cursor = readAcpUpdate(cursor, result.restarted);
    expect(cursor.snapshot.permissions).toEqual([]);
    expect(cursor.snapshot.turnCancelled).toBe(true);
    cursor = readAcpUpdate(cursor, result.suspended);
    expect(cursor.snapshot.workspace).toBe("suspended");
    expect(cursor.snapshot.messages[0].text.endsWith(" updated")).toBe(true);
    expect(result.sizes).toHaveLength(4); // suspended read never contacted bridge
    expect(result.sizes[0]).toBeGreaterThan(70000);
    expect(result.sizes[1]).toBeLessThan(200);
    expect(result.sizes[3]).toBeGreaterThan(70000); // restarted bridge sent full
    expect(result.lastActive).toBe(123);
  } finally {
    await mf.dispose();
  }
}, 20000);
