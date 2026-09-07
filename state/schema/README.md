# state/ — the task table, in prose

You are reading this because you are about to add tasks to `state/tasks.json`.

**You are a command-line agent with a full checkout of this repository in your
working directory.** You do not have a browser. Read files with your file-reading
tool, change them with a script, and commit with `git`. Nothing in this system is
done through the GitHub web interface.

There are three state files. You write to exactly one of them.

| File | Written by | You? |
|---|---|---|
| `state/tasks.json` | the daily routine (you), and `/verify` on merge | **yes — append only** |
| `state/claims.json` | the Discord bot | no |
| `state/users.json` | a human, by hand | no |

The machine-readable shapes are `state/schema/*.json`. This file is the same
thing in prose, plus the rules a JSON Schema cannot express.

---

## A task

```json
{
  "id": "t-004",
  "title": "One line, becomes the GitHub issue title",
  "contract": {
    "inputs": "What the code receives.",
    "outputs": "What it must produce.",
    "invariants": ["Properties that must hold afterwards."],
    "must_not_break": ["Existing behaviour this task may not change."]
  },
  "open_decisions": ["A real choice left to the implementer."],
  "touched_paths": ["packages/thing/**"],
  "depends_on": [],
  "issue": 12,
  "state": "open"
}
```

### `id`
`t-` and three digits. Continue from the highest id already in the file. Never
reuse an id, never renumber an existing one.

### `contract`
The interface, and it is **fixed**. An implementation that violates the contract
is wrong no matter how well it works. Write `inputs` and `outputs` precisely
enough that two competent people reading them would write the same type
signature. `invariants` and `must_not_break` are checkable statements, not
aspirations — "the response is sorted by `created_at` descending" is an
invariant; "the code should be clean" is not. Both arrays need at least one
entry.

### `open_decisions`
The point of the whole experiment. These are the choices you are **deliberately
not making** — the ones the implementer must make and then defend in their PR.

This array must not be empty. A task whose contract fully determines its
implementation is not a valid task here: if there is only one reasonable way to
build the thing you described, you have written a specification, not a task.
Discard it and write a different one. `tools/validate-state.js` rejects an empty
`open_decisions`, so a task like that cannot be committed anyway.

A good open decision names a fork in the road and implies a trade-off:

- Good: *"Whether the cache is invalidated on write or expires on a timer — correctness against a second writer versus a simpler code path."*
- Bad: *"How to implement the cache."* (That is not a decision, that is the task.)
- Bad: *"What to name the function."* (Not a real fork.)

### `touched_paths`
Glob patterns naming every file the implementation may write. This is how two
people are stopped from editing the same code with different contracts in mind,
so err on the side of listing more.

Write a directory as a glob: `src/panel/**`, never bare `src/panel`. Supported:
`*` (within one path segment), `?` (one character), `**` (any number of
segments, including none).

Two tasks that are simultaneously `open`, `claimed` or `in_review` may not have
overlapping `touched_paths` — unless one lists the other in `depends_on`, which
sequences them instead. `src/panel/**` and `src/panel/foo.ts` **do** overlap.
The validator checks this; it will not let you commit a collision.

### `depends_on`
Task ids that must reach `merged` before this task can be claimed. Use it when
the work genuinely cannot start earlier, not merely when it would be tidier.

### `issue`
The GitHub issue number, or `null` if the issue could not be created. Never
invent one. Two tasks may not share an issue number.

### `state`
Starts at `open`. Then `claimed` (bot), `in_review` (PR opened), and finally
`merged` or `rejected` (`/verify`). You only ever write `open`.

---

## Rules for a day's tasks

1. **Three tasks**, unless the cap below stops you.
2. **Stop if there are already 12 or more tasks in state `open`.** Add nothing,
   change nothing, and say so in your report. A backlog nobody is claiming is
   noise, not progress.
3. Each task completable in **under three hours** by one person.
4. Each with **at least one genuine open decision** — see above.
5. `touched_paths` must not overlap any task currently `open`, `claimed` or
   `in_review`.
6. Must not contradict any contract on a task already `merged`. Read them first.
7. Grounded in `specs/project.md`. If that file is still a template with `TODO`
   markers in it, **stop and add nothing** — tasks invented against a blank
   specification are worthless, and they poison the table for weeks.

## Before you commit

```
node tools/validate-state.js
```

It validates all three files against the schemas and checks every cross-file
rule above. **If it fails, fix the problem and run it again. Never commit state
that fails validation** — a malformed task table stops the bot for everyone
until a human notices.

Append to the `tasks` array with a script rather than by hand-editing JSON; a
misplaced comma in a 200-task file is a bad way to spend a morning.
