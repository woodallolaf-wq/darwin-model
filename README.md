# darwin-model

An experiment. A scheduled cloud agent writes task contracts every morning,
each with at least one decision deliberately left open. Five trusted people
claim those tasks through a Discord bot, implement them, and record what they
decided. A human reviews every PR against its contract before it merges.

**The repo is the database.** There is no server holding state — `state/*.json`
is the task table, the claim list and the user list, and every change to it is
a commit.

**The number that matters** is how many merged implementations survive contact
with each other. Not how many tasks got done.

## The loop

| When | Who | What |
|---|---|---|
| 08:47 daily | routine (cloud agent) | reads `specs/project.md`, appends 3 tasks to `state/tasks.json`, opens an issue each |
| during the day | a person, via Discord `/task` | claims a task, gets a thread and a branch |
| on push | GitHub Actions | proves it *runs*, and that the diff touched neither `state/` nor `tests/` |
| each evening | a human, via `/verify` | judges each PR against its contract and merges one at a time |

## How the routine actually works

It is a **cloud Claude Code session**, not a browser agent. Each morning it
gets a fresh sandbox with this repo cloned into it and a shell. It reads files,
runs `node`, and pushes with `git`. It has no browser and never touches the
GitHub web UI.

Consequences worth knowing:

- It starts on a **detached HEAD**, often several commits behind. It must
  `git checkout main && git fetch origin main && git merge --ff-only origin/main`
  before doing anything.
- It pushes **directly to `main`**. Do not add a branch-protection rule
  requiring pull requests on `main` — it would break the routine silently.
- It shares `main` with the Discord bot, which writes `state/claims.json`
  through the GitHub API. Non-fast-forward pushes happen; the routine rebases
  and retries once.
- It installs nothing. `tools/validate-state.js` is dependency-free on purpose.

## Layout

```
specs/project.md            what we are building — the routine reads this daily
state/tasks.json            the task table
state/claims.json           who holds what
state/users.json            discord_id -> github_login, hand-edited
state/schema/*.json         the canonical shapes
state/schema/README.md      the same, in prose, addressed to the routine
tools/validate-state.js     the gate: nothing writes state/ without passing this
tests/smoke/                does it run
tests/integration/          does it work — written by hand, the only ground truth
.claude/commands/verify.md  the evening review
```

## Checks

```
node tools/validate-state.js              # schemas + every cross-file rule
node tools/validate-state.js --self-test  # the glob matcher, both directions
npm run test:smoke
```

`tools/validate-state.js` is the reason a malformed task table cannot reach
`main`. It enforces the rules the schemas cannot: unique ids, resolvable
`depends_on`, claims that point at real tasks and real users, and — the one
that matters most — that no two simultaneously-active tasks have overlapping
`touched_paths`. It also rejects any task with an empty `open_decisions`, since
a task whose contract fully determines its implementation is not a task worth
running this experiment on.

## Status

Live. The daily routine generates against [specs/project.md](specs/project.md);
`state/users.json` holds the one real contributor.

The critical path is `t-002`, the Discord `/task` command. Until it ships,
nothing here or in the sibling project repos
(`woodallolaf-wq/wildplaces`, `woodallolaf-wq/nostia-landing-redesign`) can be
claimed by anybody — the claim flow does not exist yet.
