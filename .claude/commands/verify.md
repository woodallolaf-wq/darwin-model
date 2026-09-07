---
description: Review every open PR against its task contract, leading with composition risk, and merge only with explicit approval.
---

# /verify

Run this each evening. You are the only check in this system that judges
whether the work is *correct*. CI only proves it *runs*.

Never merge without asking. Never batch. One PR at a time, presented to the
human, waiting for their answer.

## 1. Gather

```
gh pr list --state open
```

For each open PR, collect:

- the diff: `gh pr diff <n>`
- the PR body, and specifically its **"What I decided"** section:
  `gh pr view <n> --json body,title,headRefName,author`
- CI status: `gh pr checks <n>`
- the linked task from `state/tasks.json` — match on the `Task: t-XXX` line in
  the PR body, and fall back to the branch name `task/t-XXX`

If a PR names no task, say so and treat it as suspect. Tasks are the unit of
work here; an unlinked PR is off-process.

## 2. Judge each PR against its contract

For each one, report:

- **inputs / outputs** — does the diff actually implement the stated interface?
- **invariants** — take each in turn and say whether the diff upholds it. Where
  you can check by running something, run it.
- **must_not_break** — take each in turn. This is where regressions hide.
- **open_decisions** — for each one, what did they decide? Quote their "What I
  decided" line. If a decision was left unaddressed, that is a finding.
- **contradiction** — does any decision here contradict a decision already
  recorded on a task in state `merged`? Read those tasks and their merged PR
  bodies; do not rely on memory.

Say plainly when the diff satisfies the contract but is poor work, and when it
is good work that does not satisfy the contract. They are different problems
with different answers.

## 3. LEAD WITH COMPOSITION RISK

**Report this first, before the per-PR detail, every time.**

The failure mode that matters in this experiment is not a bad PR. It is two
open PRs that each pass on their own while assuming different things about a
shared interface — both green, both defensible, broken the moment they are both
on main.

Look for:

- two PRs whose `touched_paths` are adjacent across a seam (one writes a
  producer, the other a consumer)
- two decisions about the same shared type, error shape, ordering guarantee,
  null-handling, or unit of measurement
- one PR relying on current behaviour of code the other PR is changing
- two PRs that both add a thing that should exist once

For each risk found: name the two PRs, the shared assumption, and what breaks
if both merge. Recommend a merge order, or say that one should be held.

If you find no composition risk, say so explicitly. Do not silently omit the
section — the silence is indistinguishable from not having looked.

## 4. Present for decision

For each PR, one at a time, offer: **merge / comment / reject**, with your
recommendation and a one-line reason. Then stop and wait.

## 5. On an approved merge

Only after the human says merge, and only for that one PR:

```
gh pr merge <n> --squash --delete-branch
```

Then update state, on `main`, in a single commit:

1. `state/tasks.json` — set that task's `state` to `"merged"`
2. `state/claims.json` — remove the claim for that task
3. `node tools/validate-state.js` — **must pass before you commit.** If it
   fails, stop and report; do not "fix" state by hand-editing around the error.
4. commit and push:
   `state: t-XXX merged (#<n>)`

On a rejection the human approves, set `state` to `"rejected"`, clear the
claim the same way, and leave a comment on the PR saying which part of the
contract it failed.

## 6. Close

Report what remains open, which claims are stale (a claim older than about
three days with no PR), and anything a human should look at directly.
