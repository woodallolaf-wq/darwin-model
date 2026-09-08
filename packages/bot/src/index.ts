/**
 * Bot entry point.
 *
 * Intents: Guilds only. Slash commands arrive as interactions, which need no
 * privileged intent — in particular not Message Content, which would drag the
 * application into Discord's verification process for no benefit.
 */

import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { StateStore } from "@darwin/state";

import { loadBotConfig } from "./config.js";
import { handleInteraction } from "./commands.js";
import { TaskService } from "./service.js";

const config = loadBotConfig();
const service = new TaskService(new StateStore(config.state));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`ready as ${c.user.tag}`);
  console.log(`projects: ${Object.keys(config.state.projects).join(", ")}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleInteraction(interaction, { service, config, client });
  } catch (error) {
    // handleInteraction already reports failures it can; this is the last resort
    // so an unexpected throw does not leave the user staring at "thinking…".
    console.error("unhandled interaction error", error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply("Something went wrong. The maintainer has the logs.").catch(() => {});
    } else {
      await interaction
        .reply({ content: "Something went wrong.", flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal} — closing`);
    client.destroy().finally(() => process.exit(0));
  });
}

await client.login(config.token);
