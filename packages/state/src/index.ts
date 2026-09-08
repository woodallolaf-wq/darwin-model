/**
 * @darwin/state — the repo as a datastore.
 *
 * `state/schema/*.json` is canonical; the zod schemas here mirror it and the
 * types are derived from those. Nothing else in the system talks to GitHub.
 */

export { StateStore } from "./store.js";
export { loadConfig, resolveRepo, type StateConfig, type EnvRecord } from "./config.js";
export { StateError, isStateError, type StateErrorCode } from "./errors.js";
export { globsIntersect, pathSetsIntersect, intersectingPairs } from "./glob.js";
export {
  DOCUMENTS,
  taskIdSchema,
  discordIdSchema,
  taskStateSchema,
  contractSchema,
  taskSchema,
  tasksDocSchema,
  claimSchema,
  claimsDocSchema,
  userSchema,
  usersDocSchema,
  type DocumentName,
  type DocumentType,
  type TaskId,
  type TaskState,
  type Contract,
  type Task,
  type TasksDoc,
  type Claim,
  type ClaimsDoc,
  type User,
  type UsersDoc,
} from "./schemas.js";
