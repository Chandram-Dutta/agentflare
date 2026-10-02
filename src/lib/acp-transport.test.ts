import { expect, test } from "bun:test";
import type { AcpSnapshot } from "./acp";
import {
  acpReadPath,
  readAcpUpdate,
  type AcpReadCursor,
} from "./acp-transport";
import { createSnapshotTransport } from "../../sandbox/acp/snapshot-transport.mjs";

function fixture(): AcpSnapshot {
  return {
    status: "running",
    messages: Array.from({ length: 240 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 ? "assistant" : "user",
      text: (`Message ${i}: ` + "x".repeat(480)).slice(0, 500),
    })),
    permissions: [],
    configOptions: [],
  };
}
const network = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("unchanged reads preserve identity and append only transfers the changed text", () => {
  const source = fixture();
  const server = createSnapshotTransport<AcpSnapshot>();
  let cursor = readAcpUpdate(undefined, network(server.read(source)));
  expect(
    readAcpUpdate(cursor, network(server.read(source, cursor.revision))),
  ).toBe(cursor);
  source.messages.at(-1)!.text += ' appended "quote" 🦊\n';
  const wire = network(server.read(source, cursor.revision));
  expect(JSON.stringify(wire).length).toBeLessThan(250);
  cursor = readAcpUpdate(cursor, wire);
  expect(cursor.snapshot).toEqual(source);
  expect(acpReadPath("thread", cursor)).toContain(
    `revision=${cursor.revision}`,
  );
});

test("tool replacement, truncation, optional field deletion, approvals and cancellation round trip", () => {
  const source = fixture();
  const server = createSnapshotTransport<AcpSnapshot>();
  let cursor: AcpReadCursor | undefined;
  const sync = () => {
    cursor = readAcpUpdate(
      cursor,
      network(server.read(source, cursor?.revision)),
    );
    expect(cursor.snapshot).toEqual(source);
  };
  sync();
  source.messages[7] = {
    id: "tool",
    role: "tool",
    text: "changed earlier tool",
    status: "in_progress",
  };
  source.permissions = [
    {
      id: "p",
      title: "Write file?",
      options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
    },
  ];
  sync();
  source.messages.splice(0, 20);
  source.truncated = true;
  source.permissions = [];
  source.status = "ready";
  source.turnCancelled = true;
  source.login = {
    id: "device",
    url: "https://example.invalid",
    message: "Login",
  };
  sync();
  delete source.login;
  delete source.turnCancelled;
  source.workspace = "suspended";
  source.saved = true;
  sync();
});

test("stale revisions reject; missed polls, restart and evicted revisions recover with full state", () => {
  const source = fixture();
  const server = createSnapshotTransport<AcpSnapshot>(2);
  const first = readAcpUpdate(undefined, network(server.read(source)));
  source.messages.at(-1)!.text += "A";
  const delta = network(server.read(source, first.revision));
  const second = readAcpUpdate(first, delta);
  expect(() => readAcpUpdate(second, delta)).toThrow("Stale");
  expect(() => readAcpUpdate(undefined, delta)).toThrow("Stale");
  source.messages.at(-1)!.text += "B";
  const evicted = network(server.read(source, first.revision));
  expect("snapshot" in evicted).toBe(true);
  expect(readAcpUpdate(first, evicted).snapshot).toEqual(source);
  const restarted = createSnapshotTransport<AcpSnapshot>().read(
    source,
    second.revision,
  );
  expect("snapshot" in restarted).toBe(true);
  expect(readAcpUpdate(second, restarted).snapshot).toEqual(source);
});

test("independent observers can reconnect from retained bases without sharing their cursor", () => {
  const source = fixture();
  const server = createSnapshotTransport<AcpSnapshot>();
  const a = readAcpUpdate(undefined, network(server.read(source)));
  source.messages.at(-1)!.text += "A";
  const b = readAcpUpdate(undefined, network(server.read(source)));
  source.messages.at(-1)!.text += "B";
  expect(
    readAcpUpdate(a, network(server.read(source, a.revision))).snapshot,
  ).toEqual(source);
  expect(
    readAcpUpdate(b, network(server.read(source, b.revision))).snapshot,
  ).toEqual(source);
});

test("representative byte and serialization benchmark (no timing pass threshold)", () => {
  for (const scenario of ["unchanged", "append"] as const) {
    const source = fixture();
    const server = createSnapshotTransport<AcpSnapshot>();
    let cursor = readAcpUpdate(undefined, network(server.read(source)));
    let fullBytes = 0,
      deltaBytes = 0,
      fullMs = 0,
      deltaMs = 0;
    for (let i = 0; i < 1000; i++) {
      if (scenario === "append") source.messages.at(-1)!.text += "x";
      let start = performance.now();
      const full = JSON.stringify(source);
      fullBytes += Buffer.byteLength(full);
      JSON.parse(full);
      fullMs += performance.now() - start;
      start = performance.now();
      const encoded = JSON.stringify(server.read(source, cursor.revision));
      deltaBytes += Buffer.byteLength(encoded);
      cursor = readAcpUpdate(cursor, JSON.parse(encoded));
      deltaMs += performance.now() - start;
    }
    expect(cursor.snapshot).toEqual(source);
    expect(deltaBytes).toBeLessThan(fullBytes / 100);
    console.log(
      JSON.stringify({
        scenario,
        calls: 1000,
        fullBytes,
        deltaBytes,
        fullMs,
        deltaMs,
      }),
    );
  }
});
