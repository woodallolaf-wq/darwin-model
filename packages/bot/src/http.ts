/**
 * The interaction endpoint, as a plain request handler.
 *
 * Platform-agnostic on purpose: it takes a Request and returns a Response, plus
 * a `defer` callback for continuing work after the response is sent. A worker
 * passes `ctx.waitUntil`; a Node server passes something that just awaits. The
 * hosting decision does not reach any further into the code than this file.
 *
 * The shape Discord requires:
 *
 *   1. Verify the Ed25519 signature over `timestamp + raw body`. Discord probes
 *      the endpoint with deliberately invalid signatures and refuses to save it
 *      unless those get a 401.
 *   2. Answer a PING (type 1) with a PONG (type 1).
 *   3. Answer a command within 3 seconds. Reading three GitHub repos does not
 *      fit, so acknowledge with a deferred response and edit the message when
 *      the work finishes.
 */

import { StateStore } from "@darwin/state";

import { loadBotConfig, type BotConfig } from "./config.js";
import { DiscordRest } from "./discord/rest.js";
import { verifyRequest } from "./discord/verify.js";
import {
  EPHEMERAL,
  InteractionResponseType,
  InteractionType,
  type Interaction,
} from "./discord/types.js";
import { isEphemeral, runCommand } from "./commands.js";
import { TaskService } from "./service.js";

export type Deferrer = (work: Promise<unknown>) => void;

export type Handler = (request: Request, defer: Deferrer) => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a handler from an environment record.
 *
 * Takes the env rather than reading `process.env`, because a worker delivers
 * bindings as an argument and has no process at all.
 */
export function createHandler(env: Record<string, string | undefined>): Handler {
  const config: BotConfig = loadBotConfig(env);
  const rest = new DiscordRest(config.token);
  const service = new TaskService(new StateStore(config.state));
  const ctx = { service, config, rest };

  return async function handle(request: Request, defer: Deferrer): Promise<Response> {
    if (request.method !== "POST") {
      // A GET is almost always a human checking the URL is alive.
      return new Response("This endpoint only accepts Discord interactions.", { status: 405 });
    }

    const signature = request.headers.get("x-signature-ed25519") ?? "";
    const timestamp = request.headers.get("x-signature-timestamp") ?? "";
    // The raw text, not a re-serialised object: re-serialising changes the
    // bytes and every signature check then fails.
    const body = await request.text();

    const verified = await verifyRequest({
      publicKeyHex: config.publicKey,
      signatureHex: signature,
      timestamp,
      body,
    });
    if (!verified) {
      return new Response("invalid request signature", { status: 401 });
    }

    let interaction: Interaction;
    try {
      interaction = JSON.parse(body) as Interaction;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    if (interaction.type === InteractionType.Ping) {
      return json({ type: InteractionResponseType.Pong });
    }

    if (interaction.type !== InteractionType.ApplicationCommand) {
      return json({ type: InteractionResponseType.Pong });
    }

    const name = interaction.data?.name ?? "";

    // Acknowledge now, finish later. The follow-up runs after this response has
    // already gone back to Discord.
    defer(
      (async () => {
        try {
          const content = await runCommand(interaction, ctx);
          await rest.editOriginalResponse(config.applicationId, interaction.token, content);
        } catch (error) {
          console.error("[follow-up]", error);
          await rest
            .editOriginalResponse(
              config.applicationId,
              interaction.token,
              "Something went wrong and the maintainer has the logs."
            )
            .catch(() => undefined);
        }
      })()
    );

    return json({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      ...(isEphemeral(name) ? { data: { flags: EPHEMERAL } } : {}),
    });
  };
}
