/**
 * The parts of Discord's interaction payloads this bot actually uses.
 *
 * Hand-written rather than pulled from discord.js: that library assumes a Node
 * runtime and a gateway connection, and importing it for type shapes would drag
 * both onto a worker that needs neither.
 */

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
} as const;

export const InteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  /** Acknowledge now, edit the message later. */
  DeferredChannelMessageWithSource: 5,
} as const;

/** Only the caller sees the reply. */
export const EPHEMERAL = 1 << 6;

export const ChannelType = { GuildText: 0, PublicThread: 11 } as const;

export type InteractionOption = {
  name: string;
  type: number;
  value?: string | number | boolean;
};

export type Interaction = {
  id: string;
  type: number;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  data?: {
    id: string;
    name: string;
    options?: InteractionOption[];
  };
  /** Present for guild interactions. */
  member?: { user: { id: string; username: string } };
  /** Present for DM interactions. */
  user?: { id: string; username: string };
};

export function userIdOf(interaction: Interaction): string | undefined {
  return interaction.member?.user.id ?? interaction.user?.id;
}

export function usernameOf(interaction: Interaction): string {
  return interaction.member?.user.username ?? interaction.user?.username ?? "someone";
}

export function stringOption(interaction: Interaction, name: string): string | undefined {
  const option = interaction.data?.options?.find((o) => o.name === name);
  return typeof option?.value === "string" ? option.value : undefined;
}
