/**
 * Typed errors.
 *
 * One of t-001's open decisions was how a 409 that survives the single retry
 * gets surfaced: a typed error the bot can catch, or a plain throw. Typed,
 * because the bot has to tell a user "someone claimed that a second before you,
 * try again" and a plain Error would leave it string-matching on messages.
 */

export type StateErrorCode =
  /** Two writers collided and the retry also lost. Safe to retry the whole operation. */
  | "conflict"
  /** The document on GitHub does not match its schema. Never overwrite blindly. */
  | "invalid_remote"
  /** The write we were about to make does not match its schema. Rejected before the network. */
  | "invalid_write"
  /** GitHub said no: bad token, missing scope, repo not granted. */
  | "access_denied"
  /** The document does not exist in the repo. */
  | "not_found"
  /** Anything else from the transport. */
  | "transport";

export class StateError extends Error {
  readonly code: StateErrorCode;
  readonly repo: string | undefined;
  readonly document: string | undefined;
  override readonly cause: unknown;

  constructor(
    code: StateErrorCode,
    message: string,
    options: { repo?: string; document?: string; cause?: unknown } = {}
  ) {
    super(message);
    this.name = "StateError";
    this.code = code;
    this.repo = options.repo;
    this.document = options.document;
    this.cause = options.cause;
  }

  /** True when retrying the whole read-modify-write might succeed. */
  get retryable(): boolean {
    return this.code === "conflict" || this.code === "transport";
  }
}

export function isStateError(e: unknown): e is StateError {
  return e instanceof StateError;
}
