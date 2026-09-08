/**
 * A fetch-based Discord REST client, covering only what the bot needs:
 * editing a deferred reply, opening a thread, and posting into it.
 *
 * discord.js would do all of this, and bring a gateway client, a cache layer
 * and a Node runtime assumption along with it.
 */

const API = "https://discord.com/api/v10";

export class DiscordRest {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.#token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Discord ${method} ${path} failed: ${res.status} ${detail.slice(0, 300)}`);
    }
    return res.status === 204 ? null : await res.json();
  }

  /**
   * Replace the "thinking…" message from a deferred acknowledgement.
   *
   * Uses the interaction token, not the bot token, so it needs no auth header —
   * but sending one is harmless and keeps a single code path.
   */
  async editOriginalResponse(applicationId: string, interactionToken: string, content: string) {
    const res = await fetch(
      `${API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Discord follow-up failed: ${res.status} ${detail.slice(0, 300)}`);
    }
  }

  async createThread(channelId: string, name: string): Promise<{ id: string }> {
    return (await this.#request("POST", `/channels/${channelId}/threads`, {
      name: name.slice(0, 100),
      // 7 days, in minutes.
      auto_archive_duration: 10080,
      type: 11,
    })) as { id: string };
  }

  async postMessage(channelId: string, content: string): Promise<void> {
    await this.#request("POST", `/channels/${channelId}/messages`, { content });
  }

  async registerGuildCommands(
    applicationId: string,
    guildId: string,
    commands: unknown[]
  ): Promise<Array<{ name: string }>> {
    return (await this.#request(
      "PUT",
      `/applications/${applicationId}/guilds/${guildId}/commands`,
      commands
    )) as Array<{ name: string }>;
  }
}
