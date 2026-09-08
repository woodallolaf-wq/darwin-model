/**
 * Who may claim what.
 *
 * Deliberately pure. Every rule that decides whether a claim is allowed lives
 * here as a function of plain data, so the interesting behaviour — "two users
 * cannot claim overlapping tasks" — is testable without a Discord connection,
 * a GitHub token, or a clock.
 *
 * The Discord layer is a thin shell over this. If a rule ever needs an
 * `Interaction` to decide, it is in the wrong file.
 */

import {
  intersectingPairs,
  pathSetsIntersect,
  type Claim,
  type ClaimsDoc,
  type Task,
  type TasksDoc,
  type UsersDoc,
} from "@darwin/state";

/** A task is "live" — someone may be editing its paths — in these states. */
export const ACTIVE_TASK_STATES = ["claimed", "in_review"] as const;

export type ProjectState = {
  /** Short project name, e.g. "wildplaces". */
  project: string;
  tasks: TasksDoc;
  claims: ClaimsDoc;
};

export type Refusal =
  | { kind: "not_a_user" }
  | { kind: "already_claimed"; claim: Claim; project: string }
  | { kind: "nothing_eligible"; reasons: SkipReason[] };

export type SkipReason = {
  taskId: string;
  title: string;
  /** Why this open task could not be handed out right now. */
  because:
    | { kind: "blocked"; unmergedDependencies: string[] }
    | { kind: "overlaps"; withTask: string; pairs: Array<[string, string]> };
};

export function isKnownUser(users: UsersDoc, discordId: string): boolean {
  return users.users.some((u) => u.discord_id === discordId);
}

/**
 * The claim a user already holds, across every project.
 *
 * One claim per person globally, not per project. Someone juggling three tasks
 * in three repos is not making progress on any of them, and the whole point of
 * the experiment is to watch work compose, not to maximise WIP.
 */
export function findExistingClaim(
  states: readonly ProjectState[],
  discordId: string
): { claim: Claim; project: string } | undefined {
  for (const state of states) {
    const claim = state.claims.claims.find((c) => c.discord_id === discordId);
    if (claim) return { claim, project: state.project };
  }
  return undefined;
}

/** Paths currently spoken for in a project: claimed and in-review tasks. */
export function activeTasks(tasks: TasksDoc): Task[] {
  return tasks.tasks.filter((t) =>
    (ACTIVE_TASK_STATES as readonly string[]).includes(t.state)
  );
}

/**
 * Pick the next task a user may claim in one project, or explain why none.
 *
 * Order: lowest id first. Of the plausible orderings — lowest id, oldest issue,
 * fewest dependents — lowest id is the only one that is stable, obvious to a
 * contributor reading the board, and impossible to game. It also matches the
 * order the routine writes them, so the backlog drains roughly first-in-first-out.
 */
export function selectTask(state: ProjectState): { task: Task } | { skipped: SkipReason[] } {
  const merged = new Set(
    state.tasks.tasks.filter((t) => t.state === "merged").map((t) => t.id)
  );
  const active = activeTasks(state.tasks);
  const skipped: SkipReason[] = [];

  const open = state.tasks.tasks
    .filter((t) => t.state === "open")
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const task of open) {
    const unmerged = task.depends_on.filter((id) => !merged.has(id));
    if (unmerged.length > 0) {
      skipped.push({
        taskId: task.id,
        title: task.title,
        because: { kind: "blocked", unmergedDependencies: unmerged },
      });
      continue;
    }

    const collision = active.find((other) =>
      pathSetsIntersect(task.touched_paths, other.touched_paths)
    );
    if (collision) {
      skipped.push({
        taskId: task.id,
        title: task.title,
        because: {
          kind: "overlaps",
          withTask: collision.id,
          pairs: intersectingPairs(task.touched_paths, collision.touched_paths),
        },
      });
      continue;
    }

    return { task };
  }

  return { skipped };
}

/**
 * The full decision for `/task project:<name>`.
 *
 * Returns either the task to hand out, or a structured refusal the Discord
 * layer can phrase. It never mutates anything — writing the claim is the
 * caller's job, and it happens through packages/state so the sha check is the
 * final arbiter if two people race.
 */
export function decideClaim(args: {
  users: UsersDoc;
  discordId: string;
  target: ProjectState;
  allStates: readonly ProjectState[];
}): { ok: true; task: Task } | { ok: false; refusal: Refusal } {
  const { users, discordId, target, allStates } = args;

  if (!isKnownUser(users, discordId)) {
    return { ok: false, refusal: { kind: "not_a_user" } };
  }

  const existing = findExistingClaim(allStates, discordId);
  if (existing) {
    return {
      ok: false,
      refusal: { kind: "already_claimed", claim: existing.claim, project: existing.project },
    };
  }

  const selection = selectTask(target);
  if ("task" in selection) return { ok: true, task: selection.task };

  return { ok: false, refusal: { kind: "nothing_eligible", reasons: selection.skipped } };
}

/** Age of a claim in whole hours, for `/status` and `/board`. */
export function claimAgeHours(claim: Claim, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(claim.claimed_at).getTime()) / 3_600_000);
}

export const STALE_CLAIM_HOURS = 72;

export function isStale(claim: Claim, now: Date = new Date()): boolean {
  return claimAgeHours(claim, now) >= STALE_CLAIM_HOURS;
}
