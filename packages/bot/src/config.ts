/**
 * Bot configuration. One zod-validated env module, layered on the state
 * package's own. Nothing else in the bot reads process.env.
 */

import { z } from "zod";
import { loadConfig as loadStateConfig, type EnvRecord, type StateConfig } from "@darwin/state";

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake (17-20 digits)");

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_APPLICATION_ID: snowflake,
  /** Ed25519 public key from the Developer Portal, General Information. */
  DISCORD_PUBLIC_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be the 64-character hex public key"),
  DISCORD_GUILD_ID: snowflake,
  DISCORD_CHANNEL_START: snowflake,
  DISCORD_CHANNEL_CODE: snowflake,
  DISCORD_CHANNEL_MERGED: snowflake,
});

export type BotConfig = {
  token: string;
  applicationId: string;
  publicKey: string;
  guildId: string;
  channels: { start: string; code: string; merged: string };
  state: StateConfig;
};

export function loadBotConfig(env: EnvRecord): BotConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`
    );
    throw new Error(`Invalid Discord environment:\n${lines.join("\n")}`);
  }
  const d = parsed.data;
  return {
    token: d.DISCORD_TOKEN,
    applicationId: d.DISCORD_APPLICATION_ID,
    publicKey: d.DISCORD_PUBLIC_KEY,
    guildId: d.DISCORD_GUILD_ID,
    channels: {
      start: d.DISCORD_CHANNEL_START,
      code: d.DISCORD_CHANNEL_CODE,
      merged: d.DISCORD_CHANNEL_MERGED,
    },
    state: loadStateConfig(env),
  };
}
