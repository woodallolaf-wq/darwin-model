/**
 * Message text. Pure string functions, no Discord types — so the wording is
 * testable and a formatting change cannot break a command handler.
 *
 * Discord hard-limits a message at 2000 characters and an embed field at 1024.
 * A task contract can exceed both, so anything that renders one truncates
 * deliberately rather than letting the API reject the send.
 */

import type { Claim, Task } from "@darwin/state";
import { claimAgeHours, isStale, type ProjectState, type Refusal, type SkipReason } from "./eligibility.js";

export const DISCORD_MESSAGE_LIMIT = 2000;

/** Trim to a budget on a line boundary, so a contract never ends mid-word. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 20);
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > limit / 2 ? cut.slice(0, lastBreak) : cut).trimEnd() + "\n… (truncated)";
}

function bullets(items: readonly string[]): string {
  return items.map((i) => `• ${i}`).join("\n");
}

export function issueUrl(repo: string, issue: number): string {
  return `https://github.com/${repo}/issues/${issue}`;
}

/**
 * The message posted into the claim thread: the contract, the open decisions,
 * the issue link, and the branch. This is the only place a contributor reads
 * what they agreed to, so it does not summarise.
 */
export function renderTaskBrief(args: {
  task: Task;
  project: string;
  repo: string;
}): string {
  const { task, project, repo } = args;
  const c = task.contract;

  const parts = [
    `**${task.id} — ${task.title}**`,
    `project \`${project}\` · branch \`task/${task.id}\``,
    task.issue !== null ? issueUrl(repo, task.issue) : "_no issue was created for this task_",
    "",
    "**Inputs**",
    c.inputs,
    "",
    "**Outputs**",
    c.outputs,
    "",
    "**Invariants**",
    bullets(c.invariants),
    "",
    "**Must not break**",
    bullets(c.must_not_break),
    "",
    "**Open decisions — these are yours to make**",
    task.open_decisions.map((d, i) => `${i + 1}. ${d}`).join("\n"),
    "",
    "Record what you chose, and why, under “What I decided” in your PR. CI fails if it is empty — those decisions are the point of this whole experiment.",
    "",
    `**Files you may touch:** ${task.touched_paths.map((p) => `\`${p}\``).join(", ")}`,
  ];

  return truncate(parts.join("\n"), DISCORD_MESSAGE_LIMIT);
}

export function renderRefusal(refusal: Refusal, project: string): string {
  switch (refusal.kind) {
    case "not_a_user":
      return (
        "You are not in `state/users.json`, so I cannot hand you a task.\n" +
        "This experiment runs with five hardcoded contributors — ask the maintainer to add your Discord id and GitHub login."
      );

    case "already_claimed": {
      const age = claimAgeHours(refusal.claim);
      return (
        `You already hold **${refusal.claim.task_id}** in \`${refusal.project}\`, claimed ${age}h ago.\n` +
        "One task at a time, across every project. Finish it, or `/release` it first."
      );
    }

    case "nothing_eligible": {
      if (refusal.reasons.length === 0) {
        return `Nothing open in \`${project}\` right now. The generator adds more on its schedule.`;
      }
      return (
        `Nothing in \`${project}\` can be claimed right now:\n` +
        refusal.reasons.map(renderSkipReason).join("\n")
      );
    }
  }
}

export function renderSkipReason(reason: SkipReason): string {
  if (reason.because.kind === "blocked") {
    return `• **${reason.taskId}** waits on ${reason.because.unmergedDependencies
      .map((d) => `\`${d}\``)
      .join(", ")}`;
  }
  const [pair] = reason.because.pairs;
  const detail = pair ? ` (\`${pair[0]}\` vs \`${pair[1]}\`)` : "";
  return `• **${reason.taskId}** overlaps **${reason.because.withTask}**, which is in progress${detail}`;
}

export function renderStatus(
  held: { claim: Claim; project: string } | undefined,
  task: Task | undefined
): string {
  if (!held) return "You hold no claim. `/task project:<name>` to pick one up.";
  const age = claimAgeHours(held.claim);
  const stale = isStale(held.claim) ? "  ⚠️ this has been open a while" : "";
  return (
    `**${held.claim.task_id}** in \`${held.project}\` — ${age}h old${stale}\n` +
    (task ? `${task.title}\n` : "") +
    `branch \`${held.claim.branch}\``
  );
}

/**
 * The board. Shows every project by default, grouped — answering "what is there
 * to do" in one command — with an optional filter when one backlog is the only
 * one that matters.
 */
export function renderBoard(states: readonly ProjectState[], now: Date = new Date()): string {
  const sections = states.map((state) => {
    const open = state.tasks.tasks.filter((t) => t.state === "open");
    const review = state.tasks.tasks.filter((t) => t.state === "in_review");
    const lines = [`**${state.project}** — ${open.length} open, ${state.claims.claims.length} claimed`];

    for (const claim of state.claims.claims) {
      const age = claimAgeHours(claim, now);
      const flag = isStale(claim, now) ? " ⚠️" : "";
      lines.push(`  ${claim.task_id} · <@${claim.discord_id}> · ${age}h${flag}`);
    }
    if (review.length > 0) {
      lines.push(`  awaiting review: ${review.map((t) => t.id).join(", ")}`);
    }
    if (open.length > 0) {
      const shown = open.slice(0, 4).map((t) => `  ${t.id} ${t.title}`);
      lines.push(...shown);
      if (open.length > shown.length) lines.push(`  …and ${open.length - shown.length} more`);
    }
    return lines.join("\n");
  });

  const body = sections.join("\n\n") || "No projects configured.";
  return truncate(body, DISCORD_MESSAGE_LIMIT);
}
