/**
 * The operations behind the commands. Knows about GitHub, knows nothing about
 * Discord — so claiming can be tested without a gateway connection.
 */

import { StateStore, isStateError, type Task } from "@darwin/state";
import {
  decideClaim,
  findExistingClaim,
  type ProjectState,
  type Refusal,
} from "./eligibility.js";

/**
 * Serialises claim and release operations within this process.
 *
 * From t-002's open decisions: an in-process queue, the sha retry in
 * packages/state, or an advisory lock document. The answer is the first two
 * together, and not the third.
 *
 * The bot runs as a single replica (P8 pins min replicas to 1), so a mutex
 * removes the common race — two people typing `/task` in the same second —
 * for almost nothing. It is not the correctness guarantee, because a mutex in
 * one process cannot help during a rolling deploy when two replicas briefly
 * overlap. The sha check in packages/state is the real arbiter, and it is
 * enforced by GitHub rather than by us.
 *
 * An advisory lock document would add a third state file, a stale-lock problem,
 * and a new way for the task table to wedge — to solve a race that optimistic
 * concurrency already solves correctly.
 */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    // Keep the chain alive even when a caller's promise rejects.
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

export type ClaimOutcome =
  | { ok: true; task: Task; branch: string; project: string; repo: string }
  | { ok: false; refusal: Refusal };

export class TaskService {
  readonly #store: StateStore;
  readonly #mutex = new Mutex();

  constructor(store: StateStore) {
    this.#store = store;
  }

  get projects(): string[] {
    return Object.keys(this.#store.config.projects);
  }

  repoFor(project: string): string {
    return this.#store.config.projects[project] ?? project;
  }

  /** Read one project's task table and claims. */
  async loadProject(project: string, options: { fresh?: boolean } = {}): Promise<ProjectState> {
    const [tasks, claims] = await Promise.all([
      this.#store.read(project, "tasks", options),
      this.#store.read(project, "claims", options),
    ]);
    return { project, tasks, claims };
  }

  /** Read every configured project. Used by /board and the one-claim-anywhere rule. */
  async loadAll(options: { fresh?: boolean } = {}): Promise<ProjectState[]> {
    return Promise.all(this.projects.map((p) => this.loadProject(p, options)));
  }

  async claim(project: string, discordId: string): Promise<ClaimOutcome> {
    return this.#mutex.run(async () => {
      // Fresh reads inside the lock: a cached table could be 30 seconds stale,
      // which is exactly long enough to hand out a task someone already took.
      const allStates = await this.loadAll({ fresh: true });
      const target = allStates.find((s) => s.project === project);
      if (!target) throw new Error(`Unknown project "${project}"`);

      const users = await this.#store.read(project, "users", { fresh: true });
      const decision = decideClaim({ users, discordId, target, allStates });
      if (!decision.ok) return decision;

      const task = decision.task;
      const branch = `task/${task.id}`;
      const claimedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");

      // Two documents, two writes, no transaction. The order is chosen so that
      // the surviving state after a partial failure is the less harmful one.
      //
      // Task first: the moment it leaves `open` nobody else can be handed it.
      // If the claim write then fails, the task is unavailable but unassigned —
      // recoverable, and visible to the validator as "claimed but nothing holds
      // it". The reverse order would leave a claim against a still-open task,
      // which lets a second person be handed the very same task.
      await this.#store.write(
        project,
        "tasks",
        (doc) => ({
          tasks: doc.tasks.map((t) => (t.id === task.id ? { ...t, state: "claimed" as const } : t)),
        }),
        `state: ${task.id} claimed`
      );

      try {
        await this.#store.write(
          project,
          "claims",
          (doc) => ({
            claims: [
              ...doc.claims,
              { task_id: task.id, discord_id: discordId, claimed_at: claimedAt, branch },
            ],
          }),
          `state: claim ${task.id}`
        );
      } catch (error) {
        // Best-effort rollback. If this also fails the task is stuck rather
        // than double-assigned, which is the failure we chose to accept.
        await this.#store
          .write(
            project,
            "tasks",
            (doc) => ({
              tasks: doc.tasks.map((t) =>
                t.id === task.id ? { ...t, state: "open" as const } : t
              ),
            }),
            `state: release ${task.id} (claim write failed)`
          )
          .catch(() => undefined);
        throw error;
      }

      return { ok: true, task, branch, project, repo: this.repoFor(project) };
    });
  }

  async release(discordId: string): Promise<{ released: string; project: string } | undefined> {
    return this.#mutex.run(async () => {
      const allStates = await this.loadAll({ fresh: true });
      const held = findExistingClaim(allStates, discordId);
      if (!held) return undefined;

      const { claim, project } = held;

      // Reverse order of claim: drop the claim first, then reopen the task. A
      // failure between them leaves an open task with no claim, which is
      // self-healing — the next /task simply hands it out again.
      await this.#store.write(
        project,
        "claims",
        (doc) => ({ claims: doc.claims.filter((c) => c.task_id !== claim.task_id) }),
        `state: release ${claim.task_id}`
      );
      await this.#store.write(
        project,
        "tasks",
        (doc) => ({
          tasks: doc.tasks.map((t) =>
            t.id === claim.task_id ? { ...t, state: "open" as const } : t
          ),
        }),
        `state: ${claim.task_id} back to open`
      );

      return { released: claim.task_id, project };
    });
  }

  /** Attach a Discord thread id to an existing claim, after the thread exists. */
  async recordThread(project: string, taskId: string, threadId: string): Promise<void> {
    await this.#store.write(
      project,
      "claims",
      (doc) => ({
        claims: doc.claims.map((c) => (c.task_id === taskId ? { ...c, thread_id: threadId } : c)),
      }),
      `state: thread for ${taskId}`
    );
  }
}

/** Turn a StateError into something worth showing a contributor. */
export function explainError(error: unknown): string {
  if (isStateError(error)) {
    switch (error.code) {
      case "conflict":
        return "Someone wrote to the task table at the same moment. Nothing was changed — try again.";
      case "access_denied":
        return "GitHub refused the write. The bot's token needs Contents: read and write on that repo.";
      case "invalid_remote":
        return `The task table in ${error.repo} does not match its schema, so I will not touch it. A human needs to look.`;
      case "invalid_write":
        return "That change would have produced an invalid task table, so it was refused before anything was sent.";
      case "not_found":
        return `${error.document} is missing from ${error.repo}.`;
      default:
        return `GitHub is not answering: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
