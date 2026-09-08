# Architecture

Orientation for anyone — human or agent — picking this up cold: what the system
is, how the pieces talk, how it came to be built this way, and the specific
things that will break it.

Written 2026-09-08, against a system that is running.

---

## 1. What this is

An experiment about whether generated work **composes**.

A scheduled agent writes task contracts every morning. Each contract fixes an
interface and deliberately leaves at least one decision open. People claim those
tasks through Discord, implement them, and record what they decided. A human
reviews every pull request against its contract before it merges.

**The number that matters is how many merged implementations survive contact
with each other** — not how many tasks got done. The failure this is built to
observe is two pull requests that each pass on their own while assuming
different things about a shared interface: both green, both defensible, broken
the moment they are both on `main`.

Everything below follows from taking that seriously.

### The repo is the database

There is no server holding state. Three JSON files under `state/` are the task
table, the claim list and the user list, and every change to them is a commit.

That is not minimalism for its own sake. It means:

- every claim is a diff, reviewable by a human
- the daily agent and the bot coordinate through git rather than through a
  service one of them owns
- there is no second source of truth to drift
- the history *is* the experiment's dataset

### Three repos

| Repo | What it is | Visibility |
|---|---|---|
| `woodallolaf-wq/darwin-model` | the harness itself, and its own task table | public |
| `woodallolaf-wq/wildplaces` | finds unmarked natural places from terrain data | public |
| `woodallolaf-wq/nostia-landing-redesign` | UI/UX redesign of the Nostia Orgs marketing site | public |

One harness, three project boards. The bot serves all three from one process.

---

## 2. The pieces

```
                    ┌──────────────────────────┐
   cron (UTC)  ───► │  routine: cloud CC agent │  reads specs/project.md
                    │  ephemeral sandbox       │  writes state/tasks.json
                    └───────────┬──────────────┘  opens GitHub issues
                                │ git push
                                ▼
   ┌─────────────────────────────────────────────────────┐
   │  GitHub repo — the database                         │
   │    specs/project.md      what we're building        │
   │    state/tasks.json      the task table             │
   │    state/claims.json     who holds what             │
   │    state/users.json      five trusted contributors  │
   │    state/schema/*.json   canonical shapes           │
   └──────┬───────────────────────────────┬──────────────┘
          │ contents API                  │ pull_request
          ▼                               ▼
   ┌──────────────────┐          ┌──────────────────────┐
   │ Cloudflare Worker│          │ GitHub Actions       │
   │  /task /status   │          │  build · diff guard  │
   │  /release /board │          │  state validity      │
   └────────┬─────────┘          │  decisions recorded  │
            │ HTTPS              └──────────────────────┘
            ▼
      Discord (interactions)              /verify — a human, each evening
```

### The generator (a routine)

A **cloud Claude Code session**, fired by cron. It gets a fresh sandbox with the
repo cloned in, a shell, and `Bash Read Write Edit Glob Grep`. It reads the
spec, appends three tasks, opens an issue each, runs the validator, commits and
pushes. Then the sandbox is destroyed.

| Routine | Repo | Cron (UTC) | Local |
|---|---|---|---|
| `trig_013LPFmam7PGCAvmUvt9VXzX` | darwin-model | `47 14 * * *` | 08:47 daily |
| `trig_01QEieiQhnYFgYjLib1YRm7A` | wildplaces | `23 15 * * *` | 09:23 daily |
| `trig_01FdUwpdvvJzKNsfnK6YRciS` | nostia-landing-redesign | `13 16 * * 2` | Tue 10:13 |

The live prompt is mirrored in each repo's `tools/routine-prompt.md`. **Editing
that file does not change the routine** — it is the source for humans; the API
holds the copy that runs.

It has **no browser**. Anything phrased as "open github.com/..." is dead on
arrival — the first version of the plan said exactly that, and would have failed
on its first step every morning.

### The bot (a Cloudflare Worker)

Not a gateway client. Discord POSTs each interaction to
`https://darwin-bot.woodallolaf.workers.dev`, so there is **no long-lived
process** — the worker is cold between commands.

This is why the bot could not be a routine, and the distinction is worth
holding: a routine is *scheduled and ephemeral*; a gateway bot needs a socket
held open *continuously*. Neither substitutes for the other. HTTP interactions
dissolve the question rather than answering it.

```
packages/bot/src/
  eligibility.ts   pure rules: who may claim what. No I/O, no Discord, no clock.
  service.ts       claim/release against GitHub. Knows nothing about Discord.
  format.ts        message text. Pure strings.
  commands.ts      maps an interaction to a call and back to text.
  http.ts          verify signature → PING/PONG → defer → follow up.
  worker.ts        ~15 lines of platform glue.
  discord/         Ed25519 verification, a fetch-based REST client, payload types.
```

The separation is load-bearing, not tidiness. `eligibility.ts` being pure is
what makes *"two users cannot claim overlapping tasks"* testable without a
gateway connection, a token or a clock. When the hosting model changed
completely — gateway to serverless — `eligibility.ts`, `service.ts` and
`format.ts` were **untouched**.

### The state layer

`packages/state` is the only code that talks to GitHub.

- **Read**: GET the blob, validate against zod, cache 30s keyed by *repo and
  document together*.
- **Write**: GET blob + sha → mutate in memory → PUT with that sha. On conflict,
  re-read and re-apply **once**, then throw a typed error.

The sha is the whole concurrency story. GitHub rejects a PUT whose sha is stale,
which turns last-writer-wins into optimistic locking for free — and that matters
because `main` has two writers: the routine pushing with git, and the bot writing
through the API.

### The gate

`tools/validate-state.js` is the piece the original plan was missing, and the
reason a malformed task table cannot reach `main`. Dependency-free CommonJS,
deliberately, so the routine's fresh sandbox never has to install anything to run
it.

It enforces what a per-file schema cannot: unique ids, resolvable `depends_on`,
claims pointing at real tasks in the right state and real users, unique issue
numbers, and — the one that matters most — **no two simultaneously-active tasks
with overlapping `touched_paths`**. It also rejects any task with an empty
`open_decisions`, because a task whose contract fully determines its
implementation is a specification, not a task.

The routine runs it before committing and abandons the commit if it fails. CI
runs it on every PR.

### CI

`pull_request` only, never `pull_request_target`, `permissions: contents: read`,
no secrets — it runs contributor code.

| Job | Asks |
|---|---|
| build and smoke | does it *run*? Not: is it correct. |
| diff guard | does the diff touch `state/` or `tests/`? Then fail. |
| state validity | schemas, cross-file rules, and the glob self-test |
| decisions recorded | is "What I decided" empty? Then fail. |

### The human

`.claude/commands/verify.md`, run each evening. It judges each PR against its
contract and **leads with composition risk** — two open PRs that each pass alone
but disagree about a shared interface. It never merges without asking, and never
batches. It is the only part of the loop that assesses *correctness*.

---

## 3. Who writes what

This table is the thing to check before adding any new writer.

| File | Written by | How |
|---|---|---|
| `specs/project.md` | a human | by hand |
| `state/tasks.json` | routine (append), `/verify` (state transitions), bot (claim/release) | git push / contents API |
| `state/claims.json` | bot only | contents API |
| `state/users.json` | a human | by hand |
| everything else | contributors | pull requests |

Two writers on `main` means non-fast-forward pushes are normal, not exceptional.
The routine rebases and retries **once**; the bot relies on the sha check.

### A claim is two writes, and there is no transaction

Claiming touches `tasks.json` (state → `claimed`) and `claims.json` (add the
record). GitHub's contents API is per-file, so a partial failure is possible.

The order is chosen so the survivable failure is the one that happens:

1. **Task state first.** The moment it leaves `open`, nobody else can be handed
   it. If the claim write then fails, the task is unavailable but unassigned —
   recoverable, and the validator flags it as "claimed but nothing holds it".
2. **Claim second**, with a best-effort rollback.

The reverse order would leave a claim against a still-open task, and a second
person could be handed **the very same task** — the one outcome the contract
forbids. Release is the mirror image: drop the claim first, so a failure leaves
an open task with no claim, which self-heals on the next `/task`.

---

## 4. How this got built

Worth recording, because several decisions look arbitrary without the history.

**It started as a plan document** (`cc-plan.md`) describing eight phases. The
plan was good about *what* to build and wrong about one mechanism, in a way that
would have failed silently every morning.

**The plan said the generator was "a browser agent driving the GitHub web UI"**
and told it to edit `state/tasks.json` "through the web editor". Checking that
against a routine which had been running daily since June showed it is nothing of
the sort: a cloud Claude Code session with a git checkout and a shell, no
browser, no web-fetch tool. Four consequences followed that the plan had no
answer for — the checkout starts on a detached HEAD, pushes go straight to
`main`, the routine is not the only writer, and a failed run is invisible unless
it reports. All four are now handled explicitly, and the mandatory
`=== ACTION REPORT ===` block came from copying what made the older routine
reliable.

**The validator came from the same place.** The older routine is dependable
because its build script refuses to write on any error, so a bad day produces no
commit rather than a broken one. The plan had no equivalent — it stated the rules
as prose in the prompt and hoped. `tools/validate-state.js` is that missing gate,
and it was written before anything depended on it.

**Three projects arrived after the design assumed one.** That forced two
decisions into the contracts rather than leaving them to be discovered: the state
client is repo-parameterised with the cache keyed by repo *and* document — without
which the second project reads the first project's tasks — and a person holds one
claim across all projects while collision detection stays per-project, because
two repos cannot share a file path.

**The bot was built outside the loop, and had to be.** `t-002` is what makes
tasks claimable, and `t-001` is its dependency, so neither could be claimed
through the system it builds. That bootstrap cost is one-time and worth stating
plainly, because waiting for the routine to hand you `t-002` would wait forever.

**The hosting model changed after it worked.** The gateway bot ran fine — on a
laptop. Asking why it could not run in the cloud like the generator surfaced the
real distinction, and HTTP interactions removed the always-on process entirely.
The rewrite cost `discord.js` and one entry point; the claim rules were not
touched. The original plan's Azure Container Apps phase, with `min replicas 1`,
would have paid for a container to sit idle 24/7 serving a dozen commands a day.

---

## 5. What will break this

Ordered by how quietly it fails.

### Silent breakage — no error, nothing happens

**Branch protection on `main` requiring pull requests.** The routine pushes
directly. It would fail every morning and you would notice when the board stopped
growing. *Do not add it.*

**`"type": "module"` in the root `package.json`.** `tools/validate-state.js` is
CommonJS and the routine invokes it with a bare `node`. Adding a root type field
disables the only safety gate the routine has. Recorded as a `must_not_break` on
`t-001`; each package declares its own ESM `package.json` instead.

**Anything requiring `npm install` before the validator runs.** The sandbox is
fresh daily. A dependency is another thing that can fail at 08:47.

**A Node-only API in `packages/bot` or `packages/state`** — `Buffer`,
`node:crypto`, `fs`. The worker runs without `nodejs_compat`, deliberately, so
this fails at build rather than at runtime. `packages/state` was made
`Buffer`-free for exactly this reason, using `atob`/`btoa` with **explicit UTF-8
conversion in both directions** — `atob` is latin1, and without that step every
em dash in a task contract corrupts silently.

**Renaming `state/schema/README.md`.** The routine reads it by path every day.

**`specs/project.md` left as a template.** The routine refuses to generate while
it contains `TODO` and reports "waiting on specs/project.md". Correct behaviour,
but it looks identical to a broken routine if you are not reading the report.

### Green checks that mean nothing

**A typecheck that passes because of a stale build.** This actually happened:
`npm run typecheck` passed locally while CI failed, because `packages/state/dist`
was left over from an earlier build and CI had none — so every `@darwin/state`
import in the bot resolved to `any` and the check was doing nothing. Fixed with
TypeScript project references. **Verify a cold checkout**, not a warm one.

**`permissions.push` on a GitHub repo object.** It describes *your* access, not
the token's. A read-only fine-grained token reports `push: true` and looks fine
right up until the bot cannot record a claim. The only honest test is attempting
a write — `tools/check-credentials.mjs` creates a throwaway ref and deletes it.

**A fine-grained PAT returning 404.** For a repo it has no grant for, GitHub
returns 404 rather than 403 — so a permissions problem reads as "missing repo".

**A public repo cloning anonymously.** A routine can clone, read everything,
generate its tasks, pass the validator, commit — and only fail at `git push`,
because the clone needed no credential at all. If the Claude GitHub App loses
access, that is what it looks like.

### State corruption

**Zod and JSON Schema drifting apart.** `state/schema/*.json` is canonical; the
zod schemas mirror it for types and a pre-network check. If they diverge, the bot
writes what CI then rejects, and the table wedges. `packages/state/test/parity.test.js`
pins field sets, required fields, the state enum, the id pattern, the non-empty
`open_decisions` rule, the five-user cap and unknown-key rejection.

**The two glob matchers diverging.** There are deliberately two — the CommonJS
one in `tools/validate-state.js` cannot be imported by a built TypeScript
package, and it must stay dependency-free for the sandbox. Both are run against
one shared case table in the parity test. If that test is ever weakened, claim
collision detection can silently disagree with what CI enforces.

**Editing `state/` by hand without running the validator.** Nothing stops a
direct push to `main`. The validator is the gate; skipping it is how a malformed
table reaches everyone.

### Operational

**Rotating a secret without `wrangler secret put`.** The worker keeps the old
value. Applies to the bot token and the GitHub PAT.

**Regenerating the Discord public key.** The endpoint rejects everything Discord
sends, which looks exactly like an outage.

**A `CLOUDFLARE_API_TOKEN` in `.env` that is wrong.** Wrangler *prefers* it over
a working OAuth login, so a stale or invalid token breaks deploys with a
confusing auth error even after `wrangler login` succeeded.

**Environment variable case.** `Cloudflare_api_token` is not
`CLOUDFLARE_API_TOKEN`. Nothing warns you.

**Work outliving the response.** The command follow-up runs under `waitUntil`
and must finish inside the platform's CPU limit. Reading three repos is
comfortably inside it; a future command that walks every task in every repo might
not be.

**The routine's sandbox is ephemeral.** If a push fails, that run's work is gone
when the container is reclaimed. Harmless — the next run regenerates — but do not
expect to recover it.

### The experiment itself

**A vague `specs/project.md`.** The generator reads it every day. Vague in, vague
out — and because those tasks get claimed, implemented and merged, one bad day
here costs a week downstream. This is the highest-leverage file in each repo.

**The backlog cap.** At 12 or more open tasks the routine adds nothing. Expected,
and it will look like a broken routine if you are not reading the report.

**One contributor.** Collision detection, the one-claim rule and the write
ordering are all tested, but none of them has been under real contention. The
first day two people claim simultaneously is the first real test of the sha
retry.

**Composition risk is the point, and nothing automated catches it.** CI proves a
PR *runs*. The integration suite in `tests/integration/` is the only check not
produced by the generator, which makes it the only real evidence the loop yields
working product rather than a pile of individually-passing pull requests. It is
currently unwritten — `t-003`.

---

## 6. Current state

| | tasks | commits |
|---|---|---|
| darwin-model | 7 — 3 open, 1 claimed, 3 merged | 21 |
| wildplaces | 9 open | 6 |
| nostia-landing-redesign | 9 open | 1 |

45 unit tests across the two packages. Three routines generating. The bot is
deployed and has handed out a real task through the full path: task state → claim
→ thread, three commits, validator clean.

What is not built: the integration suite (`t-003`, claimed), the deploy workflow
(`t-004`), a stale-claim reaper (`t-005`), and CI hardening (`t-006`).

### Reading order for someone new

1. `specs/project.md` — what is being built
2. `state/schema/README.md` — the task shape, in prose, addressed to the generator
3. `tools/validate-state.js` — the rules, as code
4. `packages/bot/src/eligibility.ts` — who may claim what
5. `docs/runbook.md`, `docs/discord-setup.md`, `docs/deploy-bot.md` — operating it
