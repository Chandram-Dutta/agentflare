import app from "vinext/server/fetch-handler";
import { api } from "./server/api";
import type { Bindings } from "./server/env";
import type { ExecutionContext } from "@cloudflare/workers-types";
export { ThreadSandbox } from "./server/sandbox";
export {
  ComputerThread as NativeThread,
  ComputerCredentials,
} from "./server/computer";

const worker = {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    // API requests bypass the RSC handler.
    if (new URL(request.url).pathname.startsWith("/api/"))
      return api.fetch(request, env, ctx);
    return app.fetch(request, env, ctx);
  },
};
export default worker;
