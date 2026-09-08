/**
 * Cloudflare Worker entry point.
 *
 * The whole file is glue: build the handler from the environment bindings, and
 * hand `ctx.waitUntil` in as the deferrer so the follow-up work survives after
 * the response has gone back to Discord.
 *
 * There is no gateway client and no long-lived process. The worker is cold
 * between interactions, which for a five-person bot is almost all the time.
 */

import { createHandler, type Handler } from "./http.js";

export type Env = Record<string, string | undefined>;

let handler: Handler | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    // Built once per isolate. Config validation therefore fails on the first
    // request rather than at deploy time — the error text names the missing
    // variable, and `wrangler tail` shows it.
    handler ??= createHandler(env);
    return handler(request, (work) => ctx.waitUntil(work));
  },
};
