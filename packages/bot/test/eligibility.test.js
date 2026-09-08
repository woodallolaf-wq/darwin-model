/**
 * The claim rules.
 *
 * The contract's headline requirement is "two users cannot claim overlapping
 * tasks". That is asserted here against plain data — no Discord, no GitHub, no
 * clock — which is the whole reason eligibility.ts is pure.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  decideClaim,
  findExistingClaim,
  selectTask,
  claimAgeHours,
  isStale,
} from "../dist/eligibility.js";

const USERS = {
  users: [
    { discord_id: "779050350534590475", github_login: "woodallolaf-wq" },
    { discord_id: "111111111111111111", github_login: "someone-else" },
  ],
};

function task(id, overrides = {}) {
  return {
    id,
    title: `Task ${id} with a long enough title`,
    contract: {
      inputs: "something long enough",
      outputs: "something long enough",
      invariants: ["holds"],
      must_not_break: ["holds"],
    },
    open_decisions: ["a genuine fork in the road, with a trade-off"],
    touched_paths: [`packages/${id}/**`],
    depends_on: [],
    issue: null,
    state: "open",
    ...overrides,
  };
}

function project(name, tasks, claims = []) {
  return { project: name, tasks: { tasks }, claims: { claims } };
}

const claimOf = (taskId, discordId, at = "2026-09-08T12:00:00Z") => ({
  task_id: taskId,
  discord_id: discordId,
  claimed_at: at,
  branch: `task/${taskId}`,
});

// --- the headline rule -----------------------------------------------------

test("a task overlapping an in-progress claim is not handed out", () => {
  const state = project("alpha", [
    task("t-001", { state: "claimed", touched_paths: ["src/panel/**"] }),
    task("t-002", { touched_paths: ["src/panel/foo.ts"] }),
  ], [claimOf("t-001", "111111111111111111")]);

  const result = selectTask(state);
  assert.ok("skipped" in result, "t-002 must not be offered");
  assert.equal(result.skipped[0].taskId, "t-002");
  assert.equal(result.skipped[0].because.kind, "overlaps");
  assert.equal(result.skipped[0].because.withTask, "t-001");
  // And it can say exactly which globs collided.
  assert.deepEqual(result.skipped[0].because.pairs[0], ["src/panel/foo.ts", "src/panel/**"]);
});

test("a task that does not overlap is handed out even while another is claimed", () => {
  const state = project("alpha", [
    task("t-001", { state: "claimed", touched_paths: ["src/panel/**"] }),
    task("t-002", { touched_paths: ["src/sidebar/**"] }),
  ], [claimOf("t-001", "111111111111111111")]);

  const result = selectTask(state);
  assert.ok("task" in result);
  assert.equal(result.task.id, "t-002");
});

test("in_review still holds its paths — a PR is out, the code is spoken for", () => {
  const state = project("alpha", [
    task("t-001", { state: "in_review", touched_paths: ["src/panel/**"] }),
    task("t-002", { touched_paths: ["src/panel/deep/thing.ts"] }),
  ], [claimOf("t-001", "111111111111111111")]);

  assert.ok("skipped" in selectTask(state));
});

test("merged tasks release their paths", () => {
  const state = project("alpha", [
    task("t-001", { state: "merged", touched_paths: ["src/panel/**"] }),
    task("t-002", { touched_paths: ["src/panel/foo.ts"] }),
  ]);
  const result = selectTask(state);
  assert.ok("task" in result);
  assert.equal(result.task.id, "t-002");
});

// --- dependencies ----------------------------------------------------------

test("a task waits for its dependencies to merge, not merely to be claimed", () => {
  const state = project("alpha", [
    task("t-001", { state: "claimed", touched_paths: ["a/**"] }),
    task("t-002", { depends_on: ["t-001"], touched_paths: ["b/**"] }),
  ], [claimOf("t-001", "111111111111111111")]);

  const result = selectTask(state);
  assert.ok("skipped" in result);
  const blocked = result.skipped.find((s) => s.taskId === "t-002");
  assert.equal(blocked.because.kind, "blocked");
  assert.deepEqual(blocked.because.unmergedDependencies, ["t-001"]);
});

test("a task becomes available once its dependency is merged", () => {
  const state = project("alpha", [
    task("t-001", { state: "merged", touched_paths: ["a/**"] }),
    task("t-002", { depends_on: ["t-001"], touched_paths: ["b/**"] }),
  ]);
  const result = selectTask(state);
  assert.ok("task" in result);
  assert.equal(result.task.id, "t-002");
});

// --- ordering --------------------------------------------------------------

test("the lowest eligible id wins", () => {
  const state = project("alpha", [task("t-005"), task("t-002"), task("t-009")]);
  const result = selectTask(state);
  assert.ok("task" in result);
  assert.equal(result.task.id, "t-002");
});

// --- who may claim ---------------------------------------------------------

test("someone not in users.json is refused", () => {
  const alpha = project("alpha", [task("t-001")]);
  const decision = decideClaim({
    users: USERS,
    discordId: "999999999999999999",
    target: alpha,
    allStates: [alpha],
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.refusal.kind, "not_a_user");
});

test("one claim per person, across every project", () => {
  const alpha = project("alpha", [task("t-001", { state: "claimed" })], [
    claimOf("t-001", "779050350534590475"),
  ]);
  const beta = project("beta", [task("t-001")]);

  const decision = decideClaim({
    users: USERS,
    discordId: "779050350534590475",
    target: beta,
    allStates: [alpha, beta],
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.refusal.kind, "already_claimed");
  assert.equal(decision.refusal.project, "alpha", "the refusal should name where the claim is");
});

test("a different person may claim in another project", () => {
  const alpha = project("alpha", [task("t-001", { state: "claimed" })], [
    claimOf("t-001", "779050350534590475"),
  ]);
  const beta = project("beta", [task("t-001")]);

  const decision = decideClaim({
    users: USERS,
    discordId: "111111111111111111",
    target: beta,
    allStates: [alpha, beta],
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.task.id, "t-001");
});

test("collision detection is per-project — identical paths in two repos do not collide", () => {
  // Two repos genuinely cannot share a file, so packages/x/** in alpha says
  // nothing about packages/x/** in beta.
  const alpha = project("alpha", [task("t-001", { state: "claimed", touched_paths: ["src/**"] })], [
    claimOf("t-001", "111111111111111111"),
  ]);
  const beta = project("beta", [task("t-001", { touched_paths: ["src/**"] })]);

  const decision = decideClaim({
    users: USERS,
    discordId: "779050350534590475",
    target: beta,
    allStates: [alpha, beta],
  });
  assert.equal(decision.ok, true);
});

test("an empty board refuses without pretending there was a collision", () => {
  const alpha = project("alpha", []);
  const decision = decideClaim({
    users: USERS,
    discordId: "779050350534590475",
    target: alpha,
    allStates: [alpha],
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.refusal.kind, "nothing_eligible");
  assert.deepEqual(decision.refusal.reasons, []);
});

// --- claims ----------------------------------------------------------------

test("findExistingClaim searches every project", () => {
  const alpha = project("alpha", []);
  const beta = project("beta", [], [claimOf("t-003", "779050350534590475")]);
  const found = findExistingClaim([alpha, beta], "779050350534590475");
  assert.equal(found.project, "beta");
  assert.equal(found.claim.task_id, "t-003");
});

test("claim age and staleness", () => {
  const now = new Date("2026-09-08T12:00:00Z");
  assert.equal(claimAgeHours(claimOf("t-001", "x", "2026-09-08T09:00:00Z"), now), 3);
  assert.equal(isStale(claimOf("t-001", "x", "2026-09-08T09:00:00Z"), now), false);
  assert.equal(isStale(claimOf("t-001", "x", "2026-09-04T09:00:00Z"), now), true);
});
