/**
 * The repo as a datastore.
 *
 * Read path : GET the blob, validate, cache for 30s.
 * Write path: GET blob + sha -> mutate in memory -> PUT with that sha.
 *             On a 409, re-read and re-apply the mutation exactly once, then throw.
 *
 * The sha is the whole concurrency story. GitHub rejects a PUT whose sha is not
 * the current one, which turns "last writer wins" into optimistic locking for
 * free. That matters because there are two writers on main: the daily routine
 * pushing tasks with git, and this library writing claims through the API.
 *
 * Decisions taken here, from t-001's open_decisions:
 *
 *  - The write API takes a **mutation callback**. Read-modify-write in one call
 *    means callers never handle a sha, and the retry can re-run the mutation
 *    against fresh content — which is the only way a retry is correct. Exposing
 *    read and write separately would make every caller reimplement that.
 *  - The cache is **per-process, in memory**, keyed by repo AND document. On
 *    disk it would have to be invalidated across processes, which is a
 *    distributed cache pretending to be a convenience. A write invalidates only
 *    the document it wrote, in the repo it wrote it to.
 *  - A 409 that survives the retry throws a typed `StateError` with code
 *    `conflict` (see errors.ts).
 */

import { Octokit } from "@octokit/rest";
import { StateError } from "./errors.js";
import { DOCUMENTS, type DocumentName, type DocumentType } from "./schemas.js";
import { loadConfig, resolveRepo, type StateConfig } from "./config.js";

type CacheEntry = { value: unknown; sha: string; expires: number };

/** GitHub's contents API needs base64, and the file is UTF-8 JSON. */
function decode(content: string): string {
  return Buffer.from(content, "base64").toString("utf8");
}
function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Serialise the way the rest of the repo writes JSON: two-space indent, real
 * UTF-8 (no \u escapes), trailing newline. A write that reformats the whole
 * file makes every diff unreviewable and fights the routine, which appends to
 * the same files with a script.
 */
function serialise(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}

export class StateStore {
  readonly #octokit: Octokit;
  readonly #config: StateConfig;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(config: StateConfig = loadConfig(), octokit?: Octokit) {
    this.#config = config;
    this.#octokit = octokit ?? new Octokit({ auth: config.githubToken });
  }

  get config(): StateConfig {
    return this.#config;
  }

  /** Project short name (`wildplaces`) or full ref (`owner/wildplaces`). */
  #resolve(project: string): { owner: string; repo: string; full: string } {
    const full = resolveRepo(this.#config, project);
    const slash = full.indexOf("/");
    return { owner: full.slice(0, slash), repo: full.slice(slash + 1), full };
  }

  #key(full: string, name: DocumentName): string {
    return `${full}:${name}`;
  }

  /** Drop cached content. Called after every successful write. */
  invalidate(project?: string, name?: DocumentName): void {
    if (project === undefined) return this.#cache.clear();
    const { full } = this.#resolve(project);
    if (name === undefined) {
      for (const key of this.#cache.keys()) {
        if (key.startsWith(`${full}:`)) this.#cache.delete(key);
      }
      return;
    }
    this.#cache.delete(this.#key(full, name));
  }

  /** Fetch and validate a document, bypassing the cache. Returns its sha too. */
  async #fetch<N extends DocumentName>(
    project: string,
    name: N
  ): Promise<{ value: DocumentType[N]; sha: string }> {
    const { owner, repo, full } = this.#resolve(project);
    const { path, schema } = DOCUMENTS[name];

    let data;
    try {
      const res = await this.#octokit.repos.getContent({
        owner,
        repo,
        path,
        ref: this.#config.branch,
      });
      data = res.data;
    } catch (error) {
      const status = statusOf(error);
      if (status === 404) {
        throw new StateError("not_found", `${path} does not exist in ${full}`, {
          repo: full,
          document: name,
          cause: error,
        });
      }
      if (status === 401 || status === 403) {
        throw new StateError(
          "access_denied",
          `GitHub refused to read ${path} in ${full}. Check the token's repo grant and Contents permission.`,
          { repo: full, document: name, cause: error }
        );
      }
      throw new StateError("transport", `Could not read ${path} from ${full}`, {
        repo: full,
        document: name,
        cause: error,
      });
    }

    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
      throw new StateError("invalid_remote", `${path} in ${full} is not a file`, {
        repo: full,
        document: name,
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(decode(data.content));
    } catch (error) {
      throw new StateError("invalid_remote", `${path} in ${full} is not valid JSON`, {
        repo: full,
        document: name,
        cause: error,
      });
    }

    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      throw new StateError(
        "invalid_remote",
        `${path} in ${full} does not match its schema:\n` +
          result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"),
        { repo: full, document: name }
      );
    }

    return { value: result.data, sha: data.sha };
  }

  /**
   * Read a document. Served from cache for `cacheMs` (30s by default).
   * Pass `{ fresh: true }` to force a network read — the write path does.
   */
  async read<N extends DocumentName>(
    project: string,
    name: N,
    options: { fresh?: boolean } = {}
  ): Promise<DocumentType[N]> {
    const { full } = this.#resolve(project);
    const key = this.#key(full, name);

    if (!options.fresh) {
      const hit = this.#cache.get(key);
      if (hit && hit.expires > Date.now()) {
        return hit.value as DocumentType[N];
      }
    }

    const { value, sha } = await this.#fetch(project, name);
    this.#cache.set(key, { value, sha, expires: Date.now() + this.#config.cacheMs });
    return value;
  }

  /**
   * Read-modify-write.
   *
   * `mutate` receives the current document and returns the new one. It may be
   * called twice — once optimistically, and again against freshly-read content
   * if the first PUT hit a 409 — so it must be a pure function of its input.
   * Mutating the argument in place and returning it works; closing over the
   * first result does not.
   */
  async write<N extends DocumentName>(
    project: string,
    name: N,
    mutate: (current: DocumentType[N]) => DocumentType[N],
    message: string
  ): Promise<DocumentType[N]> {
    const { owner, repo, full } = this.#resolve(project);
    const { path, schema } = DOCUMENTS[name];

    // One retry, and one only. A loop here would hammer the API during a
    // genuine write storm and hide the contention instead of reporting it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { value: current, sha } = await this.#fetch(project, name);
      const next = mutate(structuredClone(current));

      // Validate before the network. A document that fails its schema must
      // never reach GitHub — a malformed task table stops every contributor
      // until a human notices.
      const check = schema.safeParse(next);
      if (!check.success) {
        throw new StateError(
          "invalid_write",
          `Refusing to write ${path} to ${full} — the result fails its schema:\n` +
            check.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"),
          { repo: full, document: name }
        );
      }

      try {
        await this.#octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path,
          message,
          content: encode(serialise(check.data)),
          sha,
          branch: this.#config.branch,
        });
      } catch (error) {
        const status = statusOf(error);
        // 409 is the sha mismatch we expect under contention. 422 is what the
        // contents API actually returns for a stale sha in some cases, so treat
        // both the same rather than being right in theory and broken in fact.
        if ((status === 409 || status === 422) && attempt === 0) {
          this.invalidate(project, name);
          continue;
        }
        if (status === 409 || status === 422) {
          throw new StateError(
            "conflict",
            `${path} in ${full} changed underneath two writes in a row. Try again.`,
            { repo: full, document: name, cause: error }
          );
        }
        if (status === 401 || status === 403) {
          throw new StateError(
            "access_denied",
            `GitHub refused to write ${path} in ${full}. The token needs Contents: read and write.`,
            { repo: full, document: name, cause: error }
          );
        }
        throw new StateError("transport", `Could not write ${path} to ${full}`, {
          repo: full,
          document: name,
          cause: error,
        });
      }

      this.invalidate(project, name);
      return check.data;
    }

    // Unreachable: the loop either returns or throws.
    throw new StateError("conflict", `Gave up writing ${path} in ${full}`, {
      repo: full,
      document: name,
    });
  }
}
