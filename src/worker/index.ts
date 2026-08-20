import type { Env } from "./types";
import { handleApi } from "./api";
import { runDigest } from "./cron";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDigest(env));
  },
} satisfies ExportedHandler<Env>;
