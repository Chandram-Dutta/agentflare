import { ComputerThread } from "../computer";
import type { Bindings } from "../env";
import type { DurableObjectState } from "@cloudflare/workers-types";
import type { AcpSnapshot } from "../../lib/acp";
import { createSnapshotTransport } from "../../../sandbox/acp/snapshot-transport.mjs";

export class TransportComputer extends ComputerThread {
  private live = { running: true };
  private transcript: AcpSnapshot = {
    status: "running",
    permissions: [],
    messages: [{ id: "a", role: "assistant", text: "history".repeat(10000) }],
  };
  private wire = createSnapshotTransport<AcpSnapshot>();
  private sizes: number[] = [];
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    Object.assign(this, {
      ctx: { storage: ctx.storage, id: ctx.id, container: this.live },
      bridge: async (path: string) => {
        const url = new URL(path, "http://bridge");
        const body = JSON.stringify(
          this.wire.read(
            this.transcript,
            url.searchParams.get("revision") ?? undefined,
          ),
        );
        this.sizes.push(body.length);
        return new Response(body);
      },
      ensureBridge: () => {
        throw Error("A read must not start a bridge");
      },
    });
  }
  async exercise() {
    await this.ctx.storage.put("state", {
      id: "thread",
      owner: "alice",
      started: true,
    });
    await this.ctx.storage.put("connected", true);
    await this.ctx.storage.put("last-active", 123);
    const first = await this.userAcpRead("thread");
    const unchanged = await this.userAcpRead("thread", first.revision);
    this.transcript.messages[0].text += " updated";
    this.transcript.permissions = [{ id: "p", title: "Approve?", options: [] }];
    const changed = await this.userAcpRead("thread", first.revision);
    this.wire = createSnapshotTransport<AcpSnapshot>(); // simulate bridge restart
    this.transcript.permissions = [];
    this.transcript.turnCancelled = true;
    this.transcript.status = "ready";
    const restarted = await this.userAcpRead("thread", changed.revision);
    await this.ctx.storage.put("conversation", this.transcript);
    await this.ctx.storage.put("lifecycle", "suspended");
    this.live.running = false;
    const suspended = await this.userAcpRead("thread", restarted.revision);
    await this.ctx.storage.deleteAlarm();
    return {
      first,
      unchanged,
      changed,
      restarted,
      suspended,
      sizes: this.sizes,
      lastActive: await this.ctx.storage.get("last-active"),
    };
  }
}

export default {
  async fetch(
    _request: Request,
    env: {
      Test: { getByName(name: string): { exercise(): Promise<unknown> } };
    },
  ) {
    return Response.json(await env.Test.getByName("transport").exercise());
  },
};
