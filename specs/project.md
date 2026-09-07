# Project specification

> **STATUS: TEMPLATE — NOT YET WRITTEN.**
>
> The daily routine reads this file to invent tasks. While any `TODO` marker
> remains below, the routine is instructed to add nothing and stop. That is
> deliberate: tasks generated against a vague specification are vague, and
> because they get claimed, implemented and merged, a bad day here costs a week
> downstream.
>
> Replace every `TODO`, then delete this block. Write it as though for a
> competent contractor who has never spoken to you and cannot ask questions —
> because that is exactly what will read it.

## What we are building

TODO — Two or three sentences. What the thing is, who uses it, and what they
use it for. Concrete enough that someone could sketch a screen or a call
signature from it.

## Why it does not exist already

TODO — One paragraph. What is inadequate about the alternatives. This is what
keeps the generator from proposing features that miss the point.

## Stack and constraints

TODO — Language, runtime and versions. Frameworks that are already decided.
Anything fixed by circumstance: deployment target, budget, a system this must
talk to, a browser or device that must be supported.

## Architecture boundaries

TODO — The seams the system is divided along, and which directories own what.
The generator uses this to write non-overlapping `touched_paths`; without it,
every task collides with every other task and the table stalls.

Example of the shape wanted:

- `packages/state/**` — repo-as-datastore. Nothing else talks to the GitHub API.
- `packages/bot/**` — Discord surface. No business logic, no LLM calls.
- `tests/integration/**` — end-to-end paths only.

## Non-goals

TODO — What this project is explicitly not doing, and will reject a PR for
doing. At least three. This section does more to keep the generator honest than
any other, because an agent left alone will always propose scope.

## Definition of done

TODO — How you will know the thing works. The observable behaviour that has to
be true, not a feature checklist.

## Ground truth

The integration suite in `tests/integration/` is the only check not produced by
the generator. It is therefore the only real evidence that the loop is yielding
a working product rather than a pile of individually-passing pull requests.

TODO — Name the two or three user paths that must never break. These become the
first integration tests.
