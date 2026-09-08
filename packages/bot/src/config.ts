/**
 * Bot configuration. One zod-validated env module, layered on the state
 * package's own. Nothing else in the bot reads process.env.
 */

import { z } from "zod";
import { loadConfig as loadStateConfig, type StateConfig } from "@darwin/state";

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake (17-20 digits)");

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_APPLICATION_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  DISCORD_CHANNEL_START: snowflake,
  DISCORD_CHANNEL_CODE: snowflake,
  DISCORD_CHANNEL_MERGED: snowflake,
});

export type BotConfig = {
  token: string;
  applicationId: string;
  guildId: string;
  channels: { start: string; code: string; merged: string };
  state: StateConfig;
};

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
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
    guildId: d.DISCORD_GUILD_ID,
    channels: {
      start: d.DISCORD_CHANNEL_START,
      code: d.DISCORD_CHANNEL_CODE,
      merged: d.DISCORD_CHANNEL_MERGED,
    },
    state: loadStateConfig(env),
  };
}
