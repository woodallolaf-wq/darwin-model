# Runbook — operating the daily routine

The routine is `Darwin Model — daily task generator`,
`trig_013LPFmam7PGCAvmUvt9VXzX`, at https://claude.ai/code/routines

It fires at `47 14 * * *` UTC — 08:47 America/Denver in summer, 07:47 in
winter. Cron is always UTC; it does not follow daylight saving.

## Is it working?

The routine ends every run with a block titled `=== ACTION REPORT ===`. Read
that first. `ACTION REQUIRED BY HUMAN` names anything that needs you.

To check from a Claude Code session:

```
list the runs for trigger trig_013LPFmam7PGCAvmUvt9VXzX
then get the log for the most recent one
```

Or look at `git log --oneline state/tasks.json` — a healthy day leaves one
commit named `tasks: add t-XXX, t-XXX, t-XXX`.

## Expected non-failures

These are the routine doing its job, not breaking:

| Report says | Meaning |
|---|---|
| `waiting on specs/project.md` | The spec still contains `TODO`. Fill it in. |
| 12 or more tasks open | The backlog cap. Claim or reject some tasks. |
| `"issue": null` on new tasks | `gh` could not create issues. Tasks are still valid; add the issues by hand or ignore. |

## Real failures, and what they mean

**Push or issue creation fails with 403.** *Hit and resolved on 2026-09-07 —
the installation is now set to All repositories, so this should not recur unless
that changes.* The message reads "Claude doesn't have GitHub access to
`<owner>/<repo>`".

The Claude GitHub App is installed on **selected repositories**, and a
newly-created repo is not in that selection. Note that a *public* repo still
clones fine — anonymous clone needs no app — so a run can read the repo, do all
its work, and only fail at the very end when it pushes. Issue creation fails the
same way, earlier and more quietly, because the prompt is written to degrade to
`"issue": null` rather than stop.

Fix: add the repo at https://github.com/apps/claude/installations/select_target
(or switch that installation to "All repositories"). Until then the run's work is
lost when the sandbox is reclaimed — harmless, since the next run regenerates.

A routine cannot even be *created* against a repo the app cannot reach: the
routines API rejects it at creation time with
`You don't have access to a repository this routine uses`.

**`git merge --ff-only` fails.** Someone force-pushed `main`, or the routine's
previous run left a commit that never pushed. Inspect `main` by hand.

**Push rejected twice.** Two writers collided more than once in one run. Rare.
The commit is kept in the sandbox but the sandbox is discarded, so the work is
lost — the next day's run simply regenerates. No action needed unless it
repeats.

**The validator fails and the routine reports errors verbatim.** This is the
gate working. The routine committed nothing. Read the errors: they name the
task and the rule.

## Changing the prompt

The prompt lives in [tools/routine-prompt.md](../tools/routine-prompt.md).
Editing that file does **not** change the routine — it is the source of truth
for humans, not the live config. To apply a change, update the routine's
`job_config.ccr.events[0].data.message.content` with the fenced block from that
file.

## Things that will silently break it

- **Adding branch protection to `main` that requires pull requests.** The
  routine pushes directly. It would fail every morning.
- **Adding `"type": "module"` to the root `package.json`.** `validate-state.js`
  is CommonJS; the routine's safety gate would stop running. This is recorded
  as a `must_not_break` on `t-001`.
- **Adding dependencies that `validate-state.js` needs.** No `npm install` runs
  in the sandbox before the prompt does.
- **Renaming `state/schema/README.md`.** The routine reads it by path every day.
