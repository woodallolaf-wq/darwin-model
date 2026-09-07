# Project specification

## What we are building

The task-distribution harness for the darwin-model experiment: a system where a
scheduled agent writes task contracts into a git repo every morning, five
trusted people claim those tasks through a Discord bot, and every claim, state
transition and merge is a commit. There is no server holding state — the repo
*is* the database.

Three deliverables: a typed read/write layer over the GitHub contents API
(`packages/state`), a Discord bot that hands out non-overlapping work
(`packages/bot`), and an integration suite that proves the composed system works
(`tests/integration`).

This harness serves more than itself. The same scaffolding runs
`woodallolaf-wq/wildplaces` and `woodallolaf-wq/nostia-landing-redesign`, and
until the bot exists **no task in any of those repos can be claimed by anyone**.
That makes this repo the critical path, not a side quest.

## Why it does not exist already

Issue trackers assume a human assigns work and a human notices conflicts. This
experiment assumes neither. Tasks are generated faster than anyone reviews the
board, so the interesting failure is not a bad task — it is two people
implementing adjacent code against contracts that quietly disagree.

Nothing off the shelf prevents that, because nothing off the shelf knows that
two units of work *touch the same files*. Hence `touched_paths` and glob
intersection: the collision check has to happen at claim time, mechanically,
before anyone writes code. Putting the state in the repo rather than a database
is what makes that check reviewable — every claim is a diff.

## Stack and constraints

- Node 22, TypeScript strict, ESM for the packages. No `any`.
- Octokit against the GitHub contents API, authenticated with a fine-grained PAT
  scoped to a single repo, contents R/W + issues R/W.
- discord.js v14 for the bot. **No LLM anywhere in the bot** — it is a
  deterministic dispatcher, and an unpredictable one would be unusable.
- The repo root stays CommonJS. `tools/validate-state.js` is CommonJS and the
  daily routine invokes it with a bare `node`; adding `"type": "module"` to the
  root `package.json` disables the only safety gate the routine has. Each
  package declares its own ESM `package.json`.
- `state/schema/*.json` is canonical. Zod schemas mirror it; they never diverge
  from it unilaterally.
- Deployment target for the bot is Azure Container Apps: min replicas 1, no
  ingress (outbound websocket only), secrets in Key Vault, OIDC federated
  credentials so no service principal secret is ever stored.

## Architecture boundaries

- `packages/state/**` — the repo-as-datastore. The **only** code that talks to
  the GitHub API. Read/write for the three state documents, sha-based optimistic
  concurrency, a read cache, and zod validation before any network call.
- `packages/bot/**` — the Discord surface. Slash commands, threads, and message
  formatting. Holds no business logic beyond eligibility and no persistence of
  its own; all state goes through `packages/state`.
- `tools/**` — operator scripts that must run with zero dependencies in a fresh
  sandbox. `validate-state.js` lives here and stays dependency-free.
- `tests/smoke/**` — proves the tree runs. Fast, no network.
- `tests/integration/**` — proves the composed system works, through real user
  paths. Hand-written; never generated.
- `deploy/**` — Bicep and workflow definitions for the bot.

## Non-goals

1. **No web UI.** The board lives in Discord and in `git log`. A dashboard would
   become the place people look, and then the repo stops being the database.
2. **No open contribution.** Five hardcoded users in `state/users.json`. No
   invitations, no roles, no permission model — anyone not in that file is
   refused, and that is the whole authorisation system.
3. **No automatic merging, ever.** Every merge is a human decision made through
   `.claude/commands/verify.md`. An agent that could merge its own generated work
   would close the loop the experiment exists to measure.
4. **No LLM in the runtime path.** Generation happens in the daily routine.
   Everything downstream — claiming, validating, CI, merging — is deterministic.
5. **No task-table editing by contributors.** CI blocks any PR touching `state/`
   or `tests/`. If a contract is wrong, say so in the PR.
6. No estimates, points, velocity, burndown, or sprints.

## Definition of done

- Two people running `/task` at the same moment cannot receive tasks whose
  `touched_paths` overlap — including the `src/panel/**` vs `src/panel/foo.ts`
  case, which is the one a naive string comparison gets wrong.
- A claim survives a concurrent write: when the routine appends tasks while the
  bot writes a claim, both land, and `node tools/validate-state.js` still passes.
- `/task`, `/status`, `/release` and `/board` all work against real state, and a
  failed claim leaves nothing behind — no orphan thread, no half-written claim.
- The daily routine runs for seven consecutive days without a human touching it,
  and every run ends with an `=== ACTION REPORT ===`.
- A push to `main` redeploys the bot with no human touching a secret.
- The integration suite passes against `main` and fails loudly when a genuine
  composition break is introduced on purpose.

## Ground truth

The integration suite in `tests/integration/` is the only check not produced by
the generator. It is therefore the only real evidence that the loop is yielding
a working product rather than a pile of individually-passing pull requests.

The paths that must never break:

1. **Claim to merge.** A user runs `/task`, receives a task and a branch, opens
   a PR against that contract, and `/verify` merges it — after which the task
   reads `merged` and the claim is gone.
2. **Collision refusal.** With one task claimed, a second user running `/task`
   is never handed anything whose `touched_paths` intersect the first.
3. **The gate holds.** A deliberately malformed task table — empty
   `open_decisions`, overlapping paths, a dangling `depends_on` — is refused by
   `tools/validate-state.js`, and no commit is made.
