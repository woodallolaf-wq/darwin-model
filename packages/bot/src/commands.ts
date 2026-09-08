/**
 * The four commands: their registration shape, and what each one does.
 *
 * Thin by design. Every rule that decides whether a claim is allowed lives in
 * eligibility.ts, and every string in format.ts. This file only maps an
 * interaction to a call and back to text.
 *
 * No LLM is called anywhere in this package. The bot is a deterministic
 * dispatcher — a contributor has to trust that `/task` gives the same answer to
 * the same board.
 */

import type { BotConfig } from "./config.js";
import type { DiscordRest } from "./discord/rest.js";
import { stringOption, userIdOf, usernameOf, type Interaction } from "./discord/types.js";
import { findExistingClaim } from "./eligibility.js";
import { renderBoard, renderRefusal, renderStatus, renderTaskBrief } from "./format.js";
import { explainError, type TaskService } from "./service.js";

const STRING_OPTION = 3;

/** Command definitions, as Discord's registration API wants them. */
export function buildCommands(projects: readonly string[]) {
  const choices = projects.map((p) => ({ name: p, value: p }));
  return [
    {
      name: "task",
      description: "Claim the next available task in a project",
      options: [
        {
          name: "project",
          description: "Which project to claim from",
          type: STRING_OPTION,
          required: true,
          choices,
        },
      ],
    },
    { name: "status", description: "Show the task you currently hold" },
    { name: "release", description: "Give up the task you hold" },
    {
      name: "board",
      description: "Open tasks and active claims across every project",
      options: [
        {
          name: "project",
          description: "Limit to one project (default: show all)",
          type: STRING_OPTION,
          required: false,
          choices,
        },
      ],
    },
  ];
}

/** `/board` is public; everything else answers only the caller. */
export function isEphemeral(commandName: string): boolean {
  return commandName !== "board";
}

export type CommandContext = {
  service: TaskService;
  config: BotConfig;
  rest: DiscordRest;
};

/**
 * Run a command and return the text to put in the follow-up edit.
 *
 * Never throws: a command that blows up should tell the caller something useful
 * rather than leave Discord showing "thinking…" until it times out.
 */
export async function runCommand(interaction: Interaction, ctx: CommandContext): Promise<string> {
  const name = interaction.data?.name ?? "";
  const discordId = userIdOf(interaction);
  if (!discordId) return "I could not tell who you are.";

  try {
    switch (name) {
      case "task":
        return await runTask(interaction, ctx, discordId);
      case "status":
        return await runStatus(ctx, discordId);
      case "release":
        return await runRelease(ctx, discordId);
      case "board":
        return await runBoard(interaction, ctx);
      default:
        return `Unknown command \`${name}\`.`;
    }
  } catch (error) {
    console.error(`[${name}]`, error);
    return explainError(error);
  }
}

async function runTask(
  interaction: Interaction,
  ctx: CommandContext,
  discordId: string
): Promise<string> {
  const project = stringOption(interaction, "project");
  if (!project) return "Pick a project.";

  const outcome = await ctx.service.claim(project, discordId);
  if (!outcome.ok) return renderRefusal(outcome.refusal, project);

  const { task, branch, repo } = outcome;
  const brief = renderTaskBrief({ task, project, repo });

  // The claim is already committed. A thread is a convenience on top, so a
  // Discord failure here must not discard a successful claim.
  let threadNote = "";
  try {
    const thread = await ctx.rest.createThread(
      ctx.config.channels.code,
      `${task.id} ${task.title}`
    );
    await ctx.rest.postMessage(thread.id, `<@${discordId}> claimed this.\n\n${brief}`);
    await ctx.service.recordThread(project, task.id, thread.id);
    threadNote = `\nThread: <#${thread.id}>`;
  } catch (error) {
    console.error("[task] thread creation failed", error);
    threadNote = "\n(I could not open a thread — the claim still stands.)";
  }

  return (
    `${usernameOf(interaction)}, you now hold **${task.id}** in \`${project}\`.\n` +
    `Branch: \`${branch}\`${threadNote}\n\n${brief}`
  ).slice(0, 1900);
}

async function runStatus(ctx: CommandContext, discordId: string): Promise<string> {
  const states = await ctx.service.loadAll();
  const held = findExistingClaim(states, discordId);
  const task = held
    ? states
        .find((s) => s.project === held.project)
        ?.tasks.tasks.find((t) => t.id === held.claim.task_id)
    : undefined;
  return renderStatus(held, task);
}

async function runRelease(ctx: CommandContext, discordId: string): Promise<string> {
  const released = await ctx.service.release(discordId);
  return released
    ? `Released **${released.released}** in \`${released.project}\`. It is open again.`
    : "You hold no claim, so there is nothing to release.";
}

async function runBoard(interaction: Interaction, ctx: CommandContext): Promise<string> {
  const filter = stringOption(interaction, "project");
  const states = await ctx.service.loadAll();
  const shown = filter ? states.filter((s) => s.project === filter) : states;
  return renderBoard(shown);
}
