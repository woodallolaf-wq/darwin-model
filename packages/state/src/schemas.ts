/**
 * Zod mirrors of `state/schema/*.json`.
 *
 * The JSON Schema files are canonical — `tools/validate-state.js` reads them,
 * the daily routine is told to obey them, and CI enforces them. These zod
 * schemas exist so the bot gets types and a validation pass *before* a write
 * reaches the network. They must not drift.
 *
 * Every constraint here has a counterpart in the JSON Schema. If you change one,
 * change both, and `test/schema-parity.test.js` will fail loudly if you forget.
 */

import { z } from "zod";

/** t- followed by exactly three digits. Never reused, never renumbered. */
export const taskIdSchema = z.string().regex(/^t-\d{3}$/, "task id must look like t-001");

/** Discord snowflake. */
export const discordIdSchema = z
  .string()
  .regex(/^\d{17,20}$/, "discord id must be 17-20 digits");

export const taskStateSchema = z.enum([
  "open",
  "claimed",
  "in_review",
  "merged",
  "rejected",
]);

export const contractSchema = z
  .object({
    inputs: z.string().min(10),
    outputs: z.string().min(10),
    invariants: z.array(z.string().min(5)).min(1),
    must_not_break: z.array(z.string().min(5)).min(1),
  })
  .strict();

export const taskSchema = z
  .object({
    id: taskIdSchema,
    title: z.string().min(8).max(120),
    contract: contractSchema,
    /**
     * Must be non-empty. A task whose contract fully determines its
     * implementation is not a valid task for this experiment — it is a
     * specification. This is the single rule the whole thing exists to enforce.
     */
    open_decisions: z.array(z.string().min(10)).min(1, "a task needs at least one open decision"),
    touched_paths: z.array(z.string().min(1)).min(1),
    depends_on: z.array(taskIdSchema),
    issue: z.number().int().positive().nullable(),
    state: taskStateSchema,
  })
  .strict();

export const tasksDocSchema = z.object({ tasks: z.array(taskSchema) }).strict();

export const claimSchema = z
  .object({
    task_id: taskIdSchema,
    discord_id: discordIdSchema,
    claimed_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "claimed_at must be RFC3339 UTC"),
    branch: z.string().regex(/^task\/t-\d{3}$/),
    thread_id: discordIdSchema.optional(),
  })
  .strict();

export const claimsDocSchema = z.object({ claims: z.array(claimSchema) }).strict();

export const userSchema = z
  .object({
    discord_id: discordIdSchema,
    github_login: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, "not a GitHub login"),
    note: z.string().optional(),
  })
  .strict();

/** Five trusted users, hardcoded. The cap is the authorisation model. */
export const usersDocSchema = z
  .object({ users: z.array(userSchema).min(1).max(5) })
  .strict();

export type TaskId = z.infer<typeof taskIdSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type Contract = z.infer<typeof contractSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TasksDoc = z.infer<typeof tasksDocSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type ClaimsDoc = z.infer<typeof claimsDocSchema>;
export type User = z.infer<typeof userSchema>;
export type UsersDoc = z.infer<typeof usersDocSchema>;

export type DocumentName = "tasks" | "claims" | "users";

export type DocumentType = {
  tasks: TasksDoc;
  claims: ClaimsDoc;
  users: UsersDoc;
};

/**
 * The three documents, and the schema each one is validated against.
 *
 * Written as a mapped type rather than `as const` so that `DOCUMENTS[name]`
 * stays correctly typed when `name` is a generic parameter. With `as const`,
 * indexing by a generic collapses to a union of all three schemas and every
 * call site needs a cast — which defeats the point of having types at all.
 */
export const DOCUMENTS: {
  [K in DocumentName]: { path: string; schema: z.ZodType<DocumentType[K]> };
} = {
  tasks: { path: "state/tasks.json", schema: tasksDocSchema },
  claims: { path: "state/claims.json", schema: claimsDocSchema },
  users: { path: "state/users.json", schema: usersDocSchema },
};
