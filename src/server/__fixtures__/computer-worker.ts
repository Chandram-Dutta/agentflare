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
  private releaseArchive?: () => void;
  private fileVersion = 0;
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
      ensureBridge: async () => {
        events.push("ensure");
        await new Promise((r) => setTimeout(r, 10));
        container.running = true;
      },
      getWorkspaceContainer: () => ({
        fetchPort: async () => {
          events.push("restore");
          return new Response(null, {
            status: this.mode === "restore-fails" ? 500 : 204,
          });
        },
      }),
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
      bridge: async (
        path: string,
        _method?: string,
        body?: { type: string },
      ) => {
        if (body) events.push(`action:${body.type}`);
        if (path === "/workspace-archive") {
          if (_method === "HEAD")
            return new Response(null, {
              status: this.mode === "fingerprint-fails" ? 500 : 200,
              headers: {
                "X-Workspace-Fingerprint": this.fileVersion
                  .toString(16)
                  .padStart(64, "0"),
              },
            });
          events.push("archive");
          if (this.mode === "changes-during-save") this.fileVersion++;
          if (this.mode === "slow-save")
            await new Promise<void>((resolve) => {
              this.releaseArchive = resolve;
            });
          if (
            this.mode === "streamed-archive" ||
            this.mode === "truncated-archive"
          ) {
            const bytes = new TextEncoder().encode("archive-bytes");
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
              {
                headers: {
                  "Content-Length": String(
                    bytes.length + (this.mode === "truncated-archive" ? 1 : 0),
                  ),
                },
              },
            );
          }
          return new Response("archive-bytes", {
            headers: { "Content-Length": "13" },
          });
        }
        if (path === "/health") return new Response(null, { status: 204 });
        if (path === "/quiesce") {
          events.push("quiesce");
          return new Response(null, {
            status:
              this.mode === "busy" || this.mode === "quiesce-refused"
                ? 409
                : 204,
          });
        }
        return Response.json({
          status: this.mode === "busy" ? "running" : "ready",
          messages: [{ id: "answer", role: "assistant", text: "done" }],
          permissions: [],
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
    await this.ctx.storage.put("lifecycle", "running");
    await this.ctx.storage.put("connected", true);
    let observation;
    if (["active", "slow-save", "failure-keeps-checkpoint"].includes(mode))
      await this.ctx.storage.put("last-active", Date.now());
    if (mode === "startup-timing") {
      await this.ctx.storage.delete("state");
      Object.assign(this, {
        exec: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return `origin/main\n${"a".repeat(40)}`;
        },
      });
      await this.userStart(crypto.randomUUID(), {
        owner: "alice",
        repository: "https://test.invalid/repo",
        branch: "test",
        name: "test",
        cloneToken: "synthetic-token",
      });
    } else if (mode === "manual-save" || mode === "manual-busy") {
      if (mode === "manual-busy") this.mode = "busy";
      try {
        await this.userAcp("thread", { type: "checkpoint" });
      } catch (error) {
        observation = (error as Error).message;
      }
    } else if (mode === "retry-save") {
      await this.userAcp("thread", { type: "checkpoint" });
      const previous = await this.ctx.storage.get("checkpoint");
      this.fileVersion++;
      this.mode = "artifact-fails";
      try {
        await this.userAcp("thread", { type: "checkpoint" });
      } catch {
        observation = {
          previous,
          retained: await this.ctx.storage.get("checkpoint"),
          failed: await this.userSaved("thread"),
        };
      }
      this.mode = "active";
      await this.userAcp("thread", { type: "checkpoint" });
    } else if (
      [
        "unchanged-save",
        "background-change",
        "changes-during-save",
        "unchanged-suspend",
      ].includes(mode)
    ) {
      this.mode = "active";
      await this.userAcp("thread", { type: "checkpoint" });
      observation = await this.ctx.storage.get("checkpoint");
      this.events.length = 0;
      if (mode === "background-change" || mode === "changes-during-save")
        this.fileVersion++;
      this.mode = mode;
      try {
        await this.userAcp("thread", {
          type: mode === "unchanged-suspend" ? "suspend" : "checkpoint",
        });
      } catch {
        /* inspect consistency failure */
      }
    } else if (mode === "recover-live" || mode === "recover-live-pull-fails") {
      this.mode = "pull-fails";
      try {
        await this.userAcp("thread", { type: "suspend" });
      } catch {
        /* the stopped agent still has its working disk */
      }
      this.events.length = 0;
      if (mode === "recover-live") this.mode = "active";
      try {
        await this.userAcp("thread", { type: "connect" });
      } catch {
        /* a failed pull must prevent startup from overwriting files */
      }
    } else if (mode.startsWith("delete")) {
      try {
        await this.userDelete("thread");
      } catch {
        /* inspect the failed cleanup */
      }
    } else if (mode === "cold-read") {
      await this.ctx.container!.destroy();
      this.events.length = 0;
      observation = {
        snapshot: await this.userAcp("thread"),
        activity: await this.userActivity(),
        lastActive: await this.ctx.storage.get("last-active"),
      };
      try {
        await this.userInspect("thread", "files");
      } catch {
        /* stopped inspections must not boot */
      }
    } else if (mode === "slow-save") {
      const saving = this.alarm();
      while (!this.releaseArchive) await new Promise((r) => setTimeout(r, 1));
      try {
        observation = await Promise.race([
          Promise.all([
            this.userStatus("thread"),
            this.userSaved("thread"),
            this.userActivity(),
          ]),
          new Promise((_, reject) =>
            setTimeout(() => reject(Error("Reads blocked behind save")), 500),
          ),
        ]);
      } finally {
        this.releaseArchive();
        await saving;
      }
    } else if (mode === "resume-twice") {
      await this.ctx.container!.destroy();
      this.events.length = 0;
      observation = await Promise.all([
        this.userAcp("thread", { type: "connect" }),
        this.userAcp("thread", { type: "connect" }),
      ]);
    } else if (mode === "failure-keeps-checkpoint") {
      await this.alarm();
      observation = await this.ctx.storage.get("checkpoint");
      this.fileVersion++;
      this.mode = "artifact-fails";
      await this.alarm();
    } else if (mode === "resume-suspended" || mode === "restore-fails") {
      await this.alarm();
      try {
        await this.userAcp("thread", { type: "connect" });
      } catch {
        /* inspect failed restore */
      }
    } else if (mode === "poll-does-not-renew") {
      await this.ctx.storage.put("last-active", 123);
      await this.userAcp("thread");
      await this.userActivity();
      observation = await this.ctx.storage.get("last-active");
    } else await this.alarm();
    await this.ctx.storage.deleteAlarm();
    const checkpoint = await this.ctx.storage.get<{ prefix: string }>(
      "checkpoint",
    );
    return {
      events: this.events,
      deleted: await this.ctx.storage.get("deleted"),
      saved: await this.userSaved("thread"),
      checkpoint,
      archive: checkpoint
        ? await (
            await this.env.BACKUP_BUCKET!.get(
              `${checkpoint.prefix}/workspace.tar.gz`,
            )
          )?.text()
        : undefined,
      failure: await this.ctx.storage.get("checkpoint-error"),
      observation,
      restorePending: await this.ctx.storage.get("restore-pending"),
      startupMs: await this.ctx.storage.get<number>("startup-ms"),
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
