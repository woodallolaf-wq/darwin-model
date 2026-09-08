/**
 * The four slash commands. Thin: parse the interaction, call the service,
 * render the result. Every decision that matters lives in eligibility.ts, and
 * every string in format.ts.
 *
 * No LLM is called anywhere in this package. The bot is a deterministic
 * dispatcher — an unpredictable one would be unusable, because a contributor
 * has to trust that `/task` gives the same answer to the same board.
 */

import {
  ChannelType,
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type TextChannel,
} from "discord.js";

import type { BotConfig } from "./config.js";
import { findExistingClaim } from "./eligibility.js";
import { renderBoard, renderRefusal, renderStatus, renderTaskBrief } from "./format.js";
import { explainError, type TaskService } from "./service.js";

export function buildCommands(projects: readonly string[]) {
  const projectChoices = projects.map((p) => ({ name: p, value: p }));

  return [
    new SlashCommandBuilder()
      .setName("task")
      .setDescription("Claim the next available task in a project")
      .addStringOption((o) =>
        o
          .setName("project")
          .setDescription("Which project to claim from")
          .setRequired(true)
          .addChoices(...projectChoices)
      ),
    new SlashCommandBuilder().setName("status").setDescription("Show the task you currently hold"),
    new SlashCommandBuilder().setName("release").setDescription("Give up the task you hold"),
    new SlashCommandBuilder()
      .setName("board")
      .setDescription("Open tasks and active claims across every project")
      .addStringOption((o) =>
        o
          .setName("project")
          .setDescription("Limit to one project (default: show all)")
          .setRequired(false)
          .addChoices(...projectChoices)
      ),
  ].map((c) => c.toJSON());
}

type Ctx = { service: TaskService; config: BotConfig; client: Client };

export async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  ctx: Ctx
): Promise<void> {
  // Every command reads GitHub, which is comfortably slower than Discord's
  // 3-second reply deadline.
  await interaction.deferReply({
    flags: interaction.commandName === "board" ? undefined : MessageFlags.Ephemeral,
  });

  try {
    switch (interaction.commandName) {
      case "task":
        return await handleTask(interaction, ctx);
      case "status":
        return await handleStatus(interaction, ctx);
      case "release":
        return await handleRelease(interaction, ctx);
      case "board":
        return await handleBoard(interaction, ctx);
      default:
        await interaction.editReply(`Unknown command \`${interaction.commandName}\`.`);
    }
  } catch (error) {
    console.error(`[${interaction.commandName}]`, error);
    await interaction.editReply(explainError(error));
  }
}

async function handleTask(interaction: ChatInputCommandInteraction, ctx: Ctx): Promise<void> {
  const project = interaction.options.getString("project", true);
  const outcome = await ctx.service.claim(project, interaction.user.id);

  if (!outcome.ok) {
    await interaction.editReply(renderRefusal(outcome.refusal, project));
    return;
  }

  const { task, branch, repo } = outcome;
  const brief = renderTaskBrief({ task, project, repo });

  // The claim is already written. The thread is a convenience on top — if it
  // fails, the contributor still holds the task and still has the brief, so
  // this must not throw away a successful claim.
  let threadNote = "";
  try {
    const channel = await ctx.client.channels.fetch(ctx.config.channels.code);
    if (channel && channel.type === ChannelType.GuildText) {
      const thread = await (channel as TextChannel).threads.create({
        name: `${task.id} ${task.title}`.slice(0, 100),
        autoArchiveDuration: 10080,
        reason: `claim by ${interaction.user.tag}`,
      });
      await thread.send(`<@${interaction.user.id}> claimed this.\n\n${brief}`);
      await ctx.service.recordThread(project, task.id, thread.id);
      threadNote = `\nThread: <#${thread.id}>`;
    }
  } catch (error) {
    console.error("[task] thread creation failed", error);
    threadNote = "\n(I could not open a thread — the claim still stands.)";
  }

  await interaction.editReply(
    `You now hold **${task.id}** in \`${project}\`.\n` +
      `Branch: \`${branch}\`${threadNote}\n\n${brief}`.slice(0, 1900)
  );
}

async function handleStatus(interaction: ChatInputCommandInteraction, ctx: Ctx): Promise<void> {
  const states = await ctx.service.loadAll();
  const held = findExistingClaim(states, interaction.user.id);
  const task = held
    ? states
        .find((s) => s.project === held.project)
        ?.tasks.tasks.find((t) => t.id === held.claim.task_id)
    : undefined;
  await interaction.editReply(renderStatus(held, task));
}

async function handleRelease(interaction: ChatInputCommandInteraction, ctx: Ctx): Promise<void> {
  const released = await ctx.service.release(interaction.user.id);
  await interaction.editReply(
    released
      ? `Released **${released.released}** in \`${released.project}\`. It is open again.`
      : "You hold no claim, so there is nothing to release."
  );
}

async function handleBoard(interaction: ChatInputCommandInteraction, ctx: Ctx): Promise<void> {
  const filter = interaction.options.getString("project");
  const states = await ctx.service.loadAll();
  const shown = filter ? states.filter((s) => s.project === filter) : states;
  await interaction.editReply(renderBoard(shown));
}
