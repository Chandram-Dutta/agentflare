import { ComputerThread, ComputerCredentials } from "../computer";
import type { Bindings } from "../env";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";
import {
  Workspace,
  TestBackend,
  type DurableObjectStorageLike,
} from "@cloudflare/computer";

export { ComputerCredentials };

export class ComputerProbe extends DurableObject {
  async exercise(phase: string) {
    const workspace = new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      backends: [new TestBackend({ url: "http://127.0.0.1:19487" })],
    });
    try {
      const command =
        phase === "probe-write"
          ? "mkdir -p /workspace/.codex/sessions /run/codex; ln -s /workspace/.codex/sessions /run/codex/sessions; printf rollout-state > /run/codex/sessions/rollout.jsonl; printf transient-secret > /run/codex/auth.json; printf uncommitted-source > /workspace/source.txt"
          : "test ! -e /run/codex/auth.json && cat /workspace/source.txt /workspace/.codex/sessions/rollout.jsonl";
      const handle = await workspace.runtime.exec(command, {
        encoding: "utf8",
        sync: "defer",
      });
      const result = await handle.result();
      if (result.exitCode !== 0)
        throw Error(`Probe command failed: ${result.stderr}`);
      for await (const block of workspace.pull()) {
        if (block.skipped) throw Error("Skipped file");
      }
      return {
        stdout: result.stdout,
        source: await workspace.fs.readFile("/workspace/source.txt", "utf8"),
      };
    } finally {
      await workspace.close();
    }
  }
}

// Exercise the real lifecycle with real DO SQLite; only container I/O is faked.
export class TestComputer extends ComputerThread {
  private events: string[] = [];
  private mode = "";
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const events = this.events;
    const container = {
      running: true,
      destroy: async () => {
        events.push("destroy");
        container.running = false;
      },
    };
    Object.assign(this, {
      ctx: { storage: ctx.storage, id: ctx.id, container },
      computer: {
        pull: async function* () {
          events.push("pull");
          if (this.failPull()) throw Error("sync failure");
          yield { complete: true, skipped: this.skipFile() ? 1 : 0 };
        },
        failPull: () => this.mode === "pull-fails",
        skipFile: () => this.mode === "skipped-file",
        close: async () => {
          events.push("close");
        },
        artifacts: {
          get: async () => ({ remote: "https://test.invalid/repo" }),
          createToken: async () => ({ token: "synthetic-token" }),
          delete: async () => {
            events.push("delete-artifact");
            if (this.mode === "delete-fails") throw Error("unavailable");
          },
        },
        runtime: {
          exec: async () => ({
            result: async () => {
              events.push("artifact");
              if (this.mode === "artifact-fails") throw Error("push failure");
              return {
                exitCode: 0,
                stdout: "a".repeat(40),
                skipped: [],
                sync: { status: "completed" },
              };
            },
          }),
        },
      },
      bridge: async (path: string) => {
        if (path === "/health") return new Response(null, { status: 204 });
        if (path === "/quiesce") {
          events.push("quiesce");
          return new Response(null, {
            status: this.mode === "busy" ? 409 : 204,
          });
        }
        return Response.json({
          status: this.mode === "busy" ? "running" : "ready",
          messages: [{ id: "answer", role: "assistant", text: "done" }],
          permissions: [{ id: "secret" }],
          login: { url: "must-not-persist" },
        });
      },
    });
  }
  async exercise(mode: string) {
    this.mode = mode;
    await this.ctx.storage.put("state", {
      id: "thread",
      owner: "alice",
      started: true,
    });
    await this.ctx.storage.put("capability", "test-bridge");
    if (mode.startsWith("delete")) {
      try {
        await this.userDelete("thread");
      } catch {
        /* inspect the failed cleanup */
      }
    } else await this.alarm();
    await this.ctx.storage.deleteAlarm();
    return {
      events: this.events,
      deleted: await this.ctx.storage.get("deleted"),
      saved: await this.userSaved("thread"),
    };
  }
}

export default {
  async fetch(
    request: Request,
    env: Record<
      string,
      {
        getByName(name: string): {
          exercise(mode: string): Promise<unknown>;
          read(): Promise<unknown>;
          write(epoch: number, value: string | null): Promise<unknown>;
        };
      }
    >,
  ) {
    const input = (await request.json()) as {
      mode: string;
      name: string;
      epoch?: number;
      value?: string | null;
    };
    const stub = env[
      input.mode.startsWith("probe-")
        ? "Probe"
        : input.mode === "read" || input.mode === "write"
          ? "Vault"
          : "Test"
    ].getByName(input.name);
    return Response.json(
      input.mode === "read"
        ? await stub.read()
        : input.mode === "write"
          ? await stub.write(input.epoch!, input.value!)
          : await stub.exercise(input.mode),
    );
  },
};
