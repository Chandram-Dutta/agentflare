declare module "cloudflare:workers" {
  export const env: import("./server/env").Bindings;
  export const DurableObject: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.DurableObject;
  export const WorkerEntrypoint: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.WorkerEntrypoint;
}
