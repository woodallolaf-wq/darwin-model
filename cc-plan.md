# Claude Code Execution Plan

Generation runs as a **routine** — a scheduled cloud Claude Code session with a
git checkout and a shell. Verification runs locally in Claude Code. The repo is
the database. Five trusted users, hardcoded.

> **Corrected 2026-09-07.** The first version of this plan described the routine
> as "a browser agent driving the GitHub web UI" and told it to edit
> `state/tasks.json` "through the web editor". That is not what a routine is,
> and the daily prompt written on that assumption would have failed on its first
> step every morning. See *How a routine actually works* below; it is checked
> against a routine that has been running daily since June.

## How a routine actually works

Verified against `Smarter Than A Crow — daily questions`
(`trig_01Lp5an7JihzycBoEygjkfHn`), and against the full log of its 2026-09-06
run.

A routine fires a **cloud Claude Code session** in a fresh sandbox:

- The repos listed in `job_config.ccr.session_context.sources` are **cloned into
  the working directory** (`/home/user/<repo>`).
- Tools are whatever `allowed_tools` lists — for the crow routine,
  `Bash, Read, Write, Edit, Glob, Grep`. **There is no browser and no
  web-fetch tool.** Anything phrased as "open github.com/..." is dead on
  arrival.
- `git push` **works with no PAT in the prompt.** The sandbox already carries
  the GitHub credential from the connected account. The fine-grained PAT in
  this plan is for the Discord bot's Octokit calls only.
- Node and `python3` are available. No setup script runs unless configured, so
  anything requiring `npm install` is a daily opportunity to fail.
- `cron_expression` is **UTC**, and the minimum interval is one hour.

Four things follow that the prompt must handle explicitly:

1. **The checkout starts on a detached HEAD**, often several commits behind
   `origin/main`. The prompt must begin with
   `git checkout main && git fetch origin main && git merge --ff-only origin/main`.
   The crow agent improvises this correctly most days; that is luck, not design.
2. **Pushes go straight to `main`.** Never put a branch-protection rule
   requiring PRs on `main` — the routine would fail silently every morning.
3. **The routine is not the only writer.** The Discord bot writes
   `state/claims.json` through the API. A non-fast-forward push is inevitable,
   so the prompt must `git pull --rebase` and retry once.
4. **A run that fails is invisible unless it reports.** Every routine prompt
   ends with a mandatory report block. This is the single cheapest reliability
   measure available.

## By hand first

1. Discord server: `#start`, `#code`, `#merged`. Bot invited with Send Messages
   + Create Threads.
2. Discord app → bot token.
3. Repos: `woodallolaf-wq/darwin-model` (public, the thing being built),
   `woodallolaf-wq/darwin-bot` (private).
4. Fine-grained PAT scoped to `darwin-model` only, contents R/W + issues R/W.
   **For the bot. The routine does not use it.**
5. `specs/project.md` — what you're actually building. The generator reads this
   every day; if it's vague, everything downstream is vague. The routine is
   instructed to add nothing while the file still contains `TODO` markers.

## Repo layout (project repo)

```
specs/project.md          what we're building
state/tasks.json          the task table
state/claims.json         who has what
state/users.json          discord_id -> github_login, 5 entries
state/schema/*.json       the canonical shapes (zod mirrors these, not vice versa)
state/schema/README.md    the same in prose, addressed to the routine
tools/validate-state.js   the gate - nothing writes state/ without passing this
tests/smoke/              does it run
tests/integration/        does it work - you write these by hand
.claude/commands/verify.md
```

---

## P0 — The validation gate  *(added; everything else leans on it)*

```
Build tools/validate-state.js: dependency-free plain Node, no zod, no npm
install. It validates all three state files against state/schema/*.json and
enforces the rules a per-file schema cannot:

- unique task ids; every depends_on resolves and is not self-referential
- open_decisions is non-empty - a task whose contract fully determines its
  implementation is not a valid task, and must be impossible to commit
- no two simultaneously-active tasks have overlapping touched_paths, where
  src/panel/** overlaps src/panel/foo.ts
- claims point at real tasks in the right state, and at real users
- issue numbers are unique

Ships with --self-test, a table of glob cases run in both directions.

This is the reason the crow routine is reliable: its build script refuses to
write on any error, so a bad day produces no commit rather than a broken one.
The routine runs this before it commits and abandons the commit if it fails.

Done when a deliberately broken task table exits non-zero and names the reason.
```

## P1 — State layer

```
Build a TypeScript library (Node 22, ESM, strict, no any) that treats a GitHub
repo as a datastore. Target repo woodallolaf-wq/darwin-model, auth via
fine-grained PAT, Octokit.

packages/state exports typed read/write for state/tasks.json, state/claims.json,
state/users.json.

Write path: GET blob + sha -> mutate in memory -> PUT with that sha -> on 409,
re-read and re-apply once, then throw. 30s read cache. zod schemas for all three
files; reject any write that fails validation before it hits the network.

state/schema/*.json is canonical. The zod schemas mirror it. Keep the root
package.json CommonJS - tools/validate-state.js is CommonJS and the routine
invokes it with a bare `node`; packages/state carries its own ESM package.json.

Done when a test claims a task, sees it in the committed JSON, and releases it.
```

## P2 — Discord bot

```
Build the bot (discord.js v14) on top of packages/state. No LLM anywhere in it.

/task    picks the first task where state=open, all depends_on are merged, and
         touched_paths does not glob-intersect any active claim. Writes the claim,
         opens a thread, posts: the contract, the open_decisions list, the issue
         link, and the branch name task/<id>. Refuses if the caller already holds
         a claim or is not in users.json.
/status  caller's claim and its age
/release releases it
/board   open tasks, active claims with age, PRs awaiting review

Glob intersection is the only real logic. It must agree with the matcher in
tools/validate-state.js, which already ships the test table - reuse it rather
than writing a second, subtly different one.

Multi-stage Dockerfile, non-root, config via one zod-validated env module.
Done when two users cannot claim overlapping tasks.
```

## P3 — CI

```
In woodallolaf-wq/darwin-model add .github/workflows/pr.yml.

Trigger: pull_request only, never pull_request_target. permissions: contents read.
No secrets. GitHub-hosted runners.
Jobs: (a) install, typecheck, build, run tests/smoke - this checks it RUNS, not
that it is correct. (b) fail if the diff touches state/ or tests/ - contributors
must not edit the task table or weaken the checks. (c) run validate-state.js and
its glob self-test. (d) fail if the PR body's "What I decided" is empty.

The PR body is attacker-controlled. Pass it through env, never interpolate it
into a shell script.

Done when a broken build is red and a working-but-questionable one is green.
```

## P4 — Contract schema + seed

```
Define the task contract in state/schema/task.json and seed state/tasks.json with
three hand-written examples I can review.

Shape:
{
  "id": "t-001",
  "title": "...",
  "contract": {
    "inputs": "...", "outputs": "...",
    "invariants": ["..."], "must_not_break": ["..."]
  },
  "open_decisions": ["..."],
  "touched_paths": ["src/x/**"],
  "depends_on": [],
  "issue": 12,
  "state": "open"
}

The contract fixes the interface. open_decisions is what is deliberately left
open. A task with an empty open_decisions array is invalid - rejected by the
schema AND by P0, because the schema alone is not run by anything at write time.

issue is nullable: if `gh` cannot create the issue the task is still valid and
says so, rather than the run dying or inventing a number.

Also write state/schema/README.md explaining the shape in plain prose, addressed
to a COMMAND-LINE agent that already has the repo checked out. That file is what
the daily routine reads before writing.
```

## P5 — /verify command

```
Create .claude/commands/verify.md in the project repo. I run this each evening.

Steps:
1. gh pr list --state open
2. per PR: fetch diff, the linked task contract from state/tasks.json, smoke CI
   status, and the "What I decided" section of the PR body
3. report: does the diff satisfy inputs/outputs/invariants/must_not_break; what was
   decided in each open_decisions slot; does that decision contradict anything
   already merged
4. LEAD WITH composition risk - two open PRs that each pass alone but assume
   different things about a shared interface. That is the failure mode that matters.
   Say so explicitly when none is found; silence reads the same as not looking.
5. present each PR for merge / comment / reject. On merge: gh pr merge, then update
   state/tasks.json to merged and clear the claim from state/claims.json, and run
   validate-state.js before committing.

Never merge without asking. Never batch.
```

## P6 — Integration suite

```
Scaffold tests/integration/ plus one worked example. I write the rest by hand.

These exercise the composed system through real user paths. They are the only check
not produced by the generator, so they are the ground truth for whether the loop is
yielding working product.

Add .github/workflows/nightly.yml running them against main daily, opening an issue
labeled integration-break on failure.
```

## P7 — PR template

```
Add .github/pull_request_template.md:

  Task: t-XXX
  What I decided: (one line per open_decision)
  What I rejected and why:

CI check fails if "What I decided" is empty - enforced by job (d) of P3. This is
the data the experiment exists to collect - do not make it optional.
```

## P8 — Deploy

```
Bicep + GitHub Actions to run the bot on Azure Container Apps. Min replicas 1, no
ingress (outbound websocket only). Discord token and PAT in Key Vault. Deploy via
OIDC federated credentials - no stored service principal secret.
Done when a push to main redeploys with no human touching a secret.
```

---

## Daily routine prompt

Not pasted into a browser agent. This is the `message.content` of the routine's
event, created through the routines API with:

```
environment_id : env_01H4u9E4qaon5Tr8FGboG2YH
model          : claude-sonnet-5
sources        : https://github.com/woodallolaf-wq/darwin-model
allowed_tools  : Bash, Read, Write, Edit, Glob, Grep      (gh runs via Bash)
cron           : 47 14 * * *   (UTC - 08:47 America/Denver)
```

The live prompt is kept in `tools/routine-prompt.md` so it can be edited and
re-pushed to the routine without being retyped. Summary of what it does:

```
Sync first:      git checkout main; git fetch origin main; git merge --ff-only origin/main
Refuse to run:   if specs/project.md still contains TODO markers
Cap:             if >= 12 tasks are in state "open", add nothing and stop
Propose:         3 tasks per the four rules in state/schema/README.md
Issues:          gh issue create per task; on failure write "issue": null and say so
Write:           append via a script, never by hand-editing JSON
GATE:            node tools/validate-state.js - abandon the commit if it fails
Push:            git pull --rebase origin main, then push; retry once, never loop
Report:          mandatory === ACTION REPORT === block
```

---

## Order

Day 1: P0, P4, P3, P7, then the routine — it cannot generate against a repo
       whose schema, seed and gate do not yet exist.
Day 2: P1, P5
Day 3: P2, P6, P8

Run two weeks before changing anything. The number that matters is how many
merged implementations survive contact with each other, not how many tasks got
done.
