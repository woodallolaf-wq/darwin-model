/**
 * Register the slash commands with Discord.
 *
 * Guild-scoped, not global: guild commands appear instantly, while global ones
 * can take up to an hour to propagate. For a five-person experiment in one
 * server there is no reason to wait.
 *
 *   npm run -w @darwin/bot register
 */

import { REST, Routes } from "discord.js";
import { loadBotConfig } from "./config.js";
import { buildCommands } from "./commands.js";

const config = loadBotConfig();
const projects = Object.keys(config.state.projects);
const commands = buildCommands(projects);

const rest = new REST({ version: "10" }).setToken(config.token);

const result = (await rest.put(
  Routes.applicationGuildCommands(config.applicationId, config.guildId),
  { body: commands }
)) as Array<{ name: string }>;

console.log(
  `Registered ${result.length} command(s) to guild ${config.guildId}: ` +
    result.map((c) => "/" + c.name).join(", ")
);
console.log(`Projects offered by /task: ${projects.join(", ")}`);
