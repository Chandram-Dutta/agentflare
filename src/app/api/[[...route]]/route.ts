import { api } from "@/server/api";

export function GET(request: Request) {
  return api.fetch(request);
}

export function POST(request: Request) {
  return api.fetch(request);
}
