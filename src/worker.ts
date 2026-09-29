import app from "vinext/server/fetch-handler";
import { api } from "./server/api";
import type { Bindings } from "./server/env";
import type { ExecutionContext } from "@cloudflare/workers-types";
export { ThreadSandbox } from "./server/sandbox";

const worker = {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    // Return WebSocket upgrades directly; do not pass them through an RSC route.
    if (new URL(request.url).pathname.startsWith("/api/"))
      return api.fetch(request, env, ctx);
    return app.fetch(request, env, ctx);
  },
};
export default worker;
