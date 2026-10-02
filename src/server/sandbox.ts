import { Sandbox } from "@cloudflare/sandbox";
import type { AcpAction, AcpActivity, AcpSnapshot } from "@/lib/acp";
import { createSnapshotTransport } from "../../sandbox/acp/snapshot-transport.mjs";
import type { PublishInput } from "@/lib/runtime";
import type { Bindings } from "./env";
import { UserRuntime, type UserStart } from "./user-runtime";

export class ThreadSandbox extends Sandbox<Bindings> {
  private shared = new UserRuntime(
    this,
    this.ctx.storage,
    this.env,
    this.ctx.id.toString(),
  );
  sleepAfter = "30m";

  userStatus(id: string) {
    return this.shared.status(id);
  }
  userStart(id: string, input: UserStart) {
    return this.shared.start(id, input);
  }
  userDelete(id: string) {
    return this.shared.delete(id);
  }
  userInspect(
    id: string,
    operation: string,
    path = "",
    staged = false,
  ): Promise<unknown> {
    return this.shared.inspect(id, operation, path, staged);
  }
  userReview(id: string) {
    return this.shared.review(id);
  }
  userPublish(
    id: string,
    input: PublishInput & { branch: string; token: string },
  ) {
    return this.shared.publish(id, input);
  }
  userAcp(id: string, action?: AcpAction) {
    return this.shared.acp(id, action);
  }
  private readTransports = new Map<string, ReturnType<typeof createSnapshotTransport<AcpSnapshot>>>();
  async userAcpRead(id: string, revision?: string) {
    // Passive reads must not call shared.acp: it connects/wakes the runtime.
    if (this.ctx.container?.running) {
      const response = await this.ctx.container.getTcpPort(8766).fetch(
        `http://container/acp/${encodeURIComponent(id)}?transport=delta${revision ? `&revision=${encodeURIComponent(revision)}` : ""}`,
      );
      if (!response.ok) throw Error("Conversation unavailable.");
      const payload = await response.json() as AcpSnapshot | import("@/lib/acp-transport").AcpReadUpdate;
      if (!("status" in payload)) return payload;
      return this.savedReadTransport(id).read(payload, revision);
    }
    return this.savedReadTransport(id).read(await this.shared.userSaved(id), revision);
  }
  private savedReadTransport(id: string) {
    let transport = this.readTransports.get(id);
    if (!transport) {
      transport = createSnapshotTransport<AcpSnapshot>();
      this.readTransports.set(id, transport);
      if (this.readTransports.size > 16) this.readTransports.delete(this.readTransports.keys().next().value!);
    }
    return transport;
  }
  userSaved(id: string) {
    return this.shared.userSaved(id);
  }
  saveRuntimeCheckpoint(token: string) {
    return this.shared.checkpoint(token);
  }
  async userActivity(): Promise<Record<string, AcpActivity>> {
    // Inspect only a live container. Status polling must not boot a sandbox.
    if (!this.ctx.container?.running) return {};
    const response = await this.ctx.container
      .getTcpPort(8766)
      .fetch("http://container/activity");
    if (!response.ok) throw Error("Activity unavailable.");
    return response.json();
  }
  saveCodexCredentials(token: string, value: string | null) {
    return this.shared.persist(token, value);
  }
  override async onActivityExpired(): Promise<void> {
    // Do not deliberately discard unsaved work or interrupt a running sibling.
    // SDK calls made by prepareSleep renew activity and schedule another expiry.
    const token = await this.ctx.storage.get<string>("auth-capability");
    if (token)
      await this.shared
        .prepareSleep(() => super.onActivityExpired())
        .catch(() => false);
    else await super.onActivityExpired();
  }
}
