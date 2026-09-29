import { api } from "@/server/api";
import { env } from "cloudflare:workers";

export function GET(request: Request) {
  return api.fetch(request, env);
}

export function POST(request: Request) {
  return api.fetch(request, env);
}

export function PATCH(request: Request) {
  return api.fetch(request, env);
}
