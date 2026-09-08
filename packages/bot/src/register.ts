/**
 * Register the slash commands with Discord.
 *
 * Guild-scoped, not global: guild commands appear instantly, while global ones
 * can take up to an hour to propagate. For one server there is no reason to wait.
 *
 *   node --env-file=../../.env packages/bot/dist/register.js
 */

import { loadBotConfig } from "./config.js";
import { buildCommands } from "./commands.js";
import { DiscordRest } from "./discord/rest.js";

const config = loadBotConfig(process.env);
const projects = Object.keys(config.state.projects);
const rest = new DiscordRest(config.token);

const registered = await rest.registerGuildCommands(
  config.applicationId,
  config.guildId,
  buildCommands(projects)
);

console.log(
  `Registered ${registered.length} command(s) to guild ${config.guildId}: ` +
    registered.map((c) => "/" + c.name).join(", ")
);
console.log(`Projects offered by /task: ${projects.join(", ")}`);
