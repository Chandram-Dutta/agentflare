import { readFile } from "node:fs/promises";

// Checkpoint token rotations even when no browser is connected. One writer and
// one in-flight request preserve update ordering; failed requests retry.
export function createAuthCheckpoint({ path, url, token, fetcher = fetch }) {
  let saved;
  let inFlight;
  let stopped = false;
  let timer;
  async function sync() {
    while (inFlight) await inFlight;
    inFlight = (async () => {
      let value;
      try {
        value = await readFile(path, "utf8");
        if (value.length > 32768) throw Error("Invalid auth file");
        JSON.parse(value); // A partial native file write must never replace backup.
      } catch (error) {
        if (error.code === "ENOENT") value = null;
        else throw Error("Credential checkpoint pending");
      }
      if (value === saved) return;
      const response = await fetcher(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ credentials: value }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error("Credential checkpoint pending");
      saved = value;
    })();
    try { await inFlight; } finally { inFlight = undefined; }
  }
  async function poll() {
    try { await sync(); } catch { /* Never log token-containing errors. */ }
    if (!stopped) timer = setTimeout(poll, 1000);
  }
  void poll();
  return { sync, stop() { stopped = true; clearTimeout(timer); } };
}
