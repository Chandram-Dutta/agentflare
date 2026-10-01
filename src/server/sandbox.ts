import { Sandbox } from "@cloudflare/sandbox";
import type { AcpAction, AcpActivity } from "@/lib/acp";
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
