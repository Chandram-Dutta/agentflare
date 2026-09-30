// Periodically notify the user's Durable Object even when no browser is open.
// Calls are serialized and failures are intentionally quiet: the next tick or
// completed turn retries without leaking the bearer capability to logs/UI.
export function createCheckpointLoop({ url, token, payload, shouldContinue = () => true, fetcher = fetch, interval = 30_000, debounce = 1_000 }) {
  let stopped = false;
  let paused = false;
  let running;
  let timer;
  let debounceTimer;

  async function run() {
    if (stopped || !url || !token) return;
    if (running) return running;
    running = (async () => {
      try {
        const response = await fetcher(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(await payload()),
          signal: AbortSignal.timeout(300_000),
        });
        if (!response.ok) throw new Error("Checkpoint callback pending");
        const result = response.status === 204 ? {} : await response.json();
        paused = result.saved !== false && !shouldContinue();
        if (paused) { clearTimeout(timer); clearTimeout(debounceTimer); }
      } catch { /* Retried by a later tick; never expose capability-bearing errors. */ }
    })();
    try { await running; } finally { running = undefined; }
  }
  function tick() {
    void run().finally(() => {
      clearTimeout(timer);
      if (!stopped && !paused) timer = setTimeout(tick, interval);
    });
  }
  timer = setTimeout(tick, interval);
  return {
    settled() {
      if (stopped || !url || !token) return;
      paused = false;
      clearTimeout(timer);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(tick, debounce);
    },
    stop() { stopped = true; clearTimeout(timer); clearTimeout(debounceTimer); },
    run,
  };
}
