import { ComputerThread, ComputerCredentials } from "../computer";
export { ComputerCredentials };

// Real lifecycle + DO SQLite + R2; only native container/bridge I/O is fake.
export class TestComputer extends ComputerThread {
  async exercise(mode: string) {
    const events: string[] = [];
    let version = 1;
    let fault = "";
    let busy = mode === "busy";
    let release: (() => void) | undefined;
    const ctx = this.ctx;
    const container = {
      running: true,
      images: { workspace: "test-image" },
      start: (options: { containerSnapshot?: { id: string } }) => {
        events.push(
          options.containerSnapshot
            ? `restore:${options.containerSnapshot.id}`
            : "boot",
        );
        if (fault === "boot") throw Error("startup failed");
        container.running = true;
      },
      destroy: async () => {
        events.push("destroy");
        container.running = false;
      },
      setInactivityTimeout: async () => {
        events.push("lease");
      },
      snapshotContainer: async ({ name }: { name: string }) => {
        events.push(`snapshot:${name}`);
        if (fault === "snapshot") throw Error("snapshot unavailable");
        return { id: `disk-${version}`, size: 100 };
      },
      getTcpPort: () => ({
        fetch: async (_url: string, options?: { method?: string }) => {
          if (options?.method === "HEAD") {
            if (fault === "fingerprint")
              return new Response(null, { status: 500 });
            return new Response(null, {
              headers: {
                "X-Workspace-Fingerprint": String(version).padStart(64, "0"),
              },
            });
          }
          if (options?.method === "POST") {
            events.push("restore:r2");
            return new Response(null, {
              status: fault === "restore" ? 500 : 204,
            });
          }
          events.push("archive");
          if (fault === "slow")
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          if (fault === "archive") return new Response(null, { status: 500 });
          if (fault === "changing") version++;
          const bytes = new TextEncoder().encode("archive-bytes");
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(bytes);
                c.close();
              },
            }),
            {
              headers: {
                "Content-Length": String(
                  bytes.length + (fault === "truncated" ? 1 : 0),
                ),
              },
            },
          );
        },
      }),
    };
    Object.assign(this, {
      ctx: { storage: ctx.storage, id: ctx.id, container },
      exec: async () => {
        events.push("exec");
        return "{}";
      },
      ensureBridge: async () => {
        events.push("ensure");
        if (fault === "bridge") throw Error("bridge unavailable");
      },
      bridge: async (
        path: string,
        _method?: string,
        action?: { type: string },
      ) => {
        if (fault === "activity") throw Error("unknown activity");
        if (path === "/quiesce") {
          events.push("quiesce");
          return new Response(null, {
            status: fault === "refused" ? 409 : 204,
          });
        }
        if (action) events.push(`action:${action.type}`);
        return Response.json({
          status: busy ? "running" : "ready",
          messages: [{ id: "answer", role: "assistant", text: "done" }],
          permissions: [],
        });
      },
    });
    await ctx.storage.put({
      state: { id: "thread", owner: "alice", started: true, agent: "codex" },
      lifecycle: "running",
      connected: true,
    });
    const save = () => this.userAcp("thread", { type: "checkpoint" });
    const attempt = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch {
        /* inspect durable result */
      }
    };
    let before: unknown;
    let during: unknown;
    if (mode === "busy" || mode === "unknown-activity") {
      if (mode === "unknown-activity") fault = "activity";
      await this.alarm();
    } else if (mode === "idle") {
      await this.alarm();
    } else if (mode === "live-recovery") {
      busy = true;
      await this.alarm();
      busy = false;
      container.running = false;
      events.length = 0;
      await this.userAcp("thread", { type: "connect" });
    } else if (mode === "no-checkpoint") {
      container.running = false;
      await attempt(() =>
        this.userAcp("thread", {
          type: "prompt",
          text: "new",
          requestId: crypto.randomUUID(),
        }),
      );
    } else if (mode === "passive") {
      container.running = false;
      await this.userSaved("thread");
      await this.userAcpRead("thread");
      await this.userActivity();
    } else if (mode === "failed-suspend") {
      fault = "archive";
      await this.alarm();
      during = await this.userSaved("thread");
      fault = "";
      await this.alarm();
    } else if (mode === "interrupted-suspend") {
      await ctx.storage.put("lifecycle", "suspending");
      during = await this.userSaved("thread");
      await this.userAcp("thread", { type: "connect" });
    } else if (mode === "slow-save" || mode === "queued-prompt") {
      fault = "slow";
      const saving =
        mode === "queued-prompt"
          ? this.userAcp("thread", { type: "suspend" })
          : save();
      while (!release) await new Promise((r) => setTimeout(r, 1));
      during = await this.userSaved("thread");
      const prompt =
        mode === "queued-prompt"
          ? this.userAcp("thread", {
              type: "prompt",
              text: "continue",
              requestId: crypto.randomUUID(),
            })
          : undefined;
      release();
      await saving;
      await prompt;
    } else if (
      ["archive", "truncated", "snapshot", "fingerprint", "refused"].includes(
        mode,
      )
    ) {
      fault = mode;
      await attempt(() => this.userAcp("thread", { type: "suspend" }));
    } else {
      await save();
      before = await ctx.storage.get("checkpoint");
      events.length = 0;
      if (mode === "changed" || mode === "changing" || mode === "retry")
        version++;
      if (mode === "changing") fault = "changing";
      if (mode === "retry") {
        fault = "archive";
        await attempt(save);
        during = {
          checkpoint: await ctx.storage.get("checkpoint"),
          saved: await this.userSaved("thread"),
        };
        fault = "";
      }
      if (
        [
          "resume",
          "restore-fails",
          "expired",
          "image-update",
          "message",
          "inspect",
          "concurrent",
          "boot-fails",
        ].includes(mode)
      ) {
        container.running = false;
        await ctx.storage.put("lifecycle", "suspended");
        if (mode === "image-update")
          container.images.workspace = "updated-image";
        if (mode === "expired" || mode === "restore-fails") {
          const checkpoint = await ctx.storage.get<{ snapshot: object }>(
            "checkpoint",
          );
          await ctx.storage.put("checkpoint", {
            ...checkpoint,
            snapshot: { ...checkpoint!.snapshot, at: 0 },
          });
        }
        if (mode === "restore-fails") fault = "restore";
        if (mode === "boot-fails") fault = "boot";
        await attempt(async () => {
          if (mode === "message")
            return this.userAcp("thread", {
              type: "prompt",
              text: "new",
              requestId: crypto.randomUUID(),
            });
          if (mode === "inspect") return this.userInspect("thread", "files");
          if (mode === "concurrent")
            return Promise.all([
              this.userAcp("thread", { type: "connect" }),
              this.userAcp("thread", { type: "connect" }),
            ]);
          return this.userAcp("thread", { type: "connect" });
        });
      } else await attempt(save);
    }
    const alarm = await ctx.storage.getAlarm();
    await ctx.storage.deleteAlarm();
    // Unknown activity must not make the final fixture observation fail.
    fault = "";
    return {
      events,
      before,
      during,
      alarm,
      saved: await this.userSaved("thread"),
      checkpoint: await ctx.storage.get("checkpoint"),
      recovery: await ctx.storage.get("live-snapshot"),
      pending: await ctx.storage.get("restore-pending"),
    };
  }
}

export default {
  async fetch(
    request: Request,
    env: {
      Test: { getByName(name: string): TestComputer };
      Vault: { getByName(name: string): ComputerCredentials };
    },
  ) {
    const input = (await request.json()) as {
      mode: string;
      name: string;
      epoch: number;
      value: string | null;
    };
    return Response.json(
      input.mode === "read"
        ? await env.Vault.getByName(input.name).read()
        : input.mode === "write"
          ? await env.Vault.getByName(input.name).write(
              input.epoch,
              input.value,
            )
          : await env.Test.getByName(input.name).exercise(input.mode),
    );
  },
};
