// Run inside the built sandbox image; exercises the same pre-created PTY as SDK.
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";

const directory = await mkdtemp("/tmp/agentflare-pty-");
await symlink("/opt/agentflare/launch-agent.sh", `${directory}/node`);
let output = "";
const terminal = new Bun.Terminal({
  cols: 83,
  rows: 27,
  data(_terminal, bytes) {
    output += Buffer.from(bytes).toString();
  },
});
const process = Bun.spawn(
  [
    `${directory}/node`,
    "-e",
    `
    const stdout = process.stdout;
    stdout.on('resize', () => console.log('SIZE:' + stdout.columns + 'x' + stdout.rows));
    process.stdin.on('data', () => console.log('INPUT-RECEIVED'));
    console.log('READY');
    setInterval(() => {}, 1000);
  `,
  ],
  { terminal },
);

async function waitFor(text: string) {
  const deadline = Date.now() + 10000;
  while (!output.includes(text) && Date.now() < deadline) await Bun.sleep(20);
  assert.ok(
    output.includes(text),
    `Missing ${text}; received ${JSON.stringify(output)}`,
  );
}

try {
  await waitFor("READY");
  terminal.resize(37, 19);
  await waitFor("SIZE:37x19");
  terminal.resize(112, 43);
  await waitFor("SIZE:112x43");
  terminal.write("hello\n");
  await waitFor("INPUT-RECEIVED");
  console.log(
    "PASS: shrink/grow deliver SIGWINCH with correct geometry; input still works",
  );
} finally {
  process.kill();
  await process.exited;
  terminal.close();
  await rm(directory, { recursive: true });
}
