/**
 * One zod-validated environment module. Nothing else in the system reads
 * `process.env` — a missing variable should fail at startup with a message
 * naming it, not at 2am inside a command handler.
 */

import { z } from "zod";

const repoRef = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'a repo must look like "owner/name"');

const envSchema = z.object({
  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),
  /** Comma-separated owner/name. The first is the default project. */
  GITHUB_REPOS: z
    .string()
    .min(1, "GITHUB_REPOS is required")
    .transform((s) => s.split(",").map((r) => r.trim()).filter(Boolean))
    .pipe(z.array(repoRef).min(1, "GITHUB_REPOS must name at least one repo")),
  /** Branch the state documents live on. */
  GITHUB_BRANCH: z.string().min(1).default("main"),
  /** Read cache lifetime in milliseconds. The contract says 30 seconds. */
  STATE_CACHE_MS: z.coerce.number().int().nonnegative().default(30_000),
});

export type StateConfig = {
  githubToken: string;
  repos: string[];
  branch: string;
  cacheMs: number;
  /** Short name (the repo half of owner/name) → full owner/name. */
  projects: Record<string, string>;
};

/**
 * Reads and validates configuration. Throws with every problem listed, rather
 * than the first one, so a misconfigured deploy is one fix rather than five.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): StateConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }

  const { GITHUB_TOKEN, GITHUB_REPOS, GITHUB_BRANCH, STATE_CACHE_MS } = parsed.data;

  const projects: Record<string, string> = {};
  for (const full of GITHUB_REPOS) {
    const short = full.slice(full.indexOf("/") + 1);
    if (projects[short] !== undefined) {
      throw new Error(
        `Two repos in GITHUB_REPOS share the short name "${short}". ` +
          `Project names come from the repo half of owner/name and must be unique.`
      );
    }
    projects[short] = full;
  }

  return {
    githubToken: GITHUB_TOKEN,
    repos: GITHUB_REPOS,
    branch: GITHUB_BRANCH,
    cacheMs: STATE_CACHE_MS,
    projects,
  };
}

/** Resolve a project name (`wildplaces`) or a full ref (`owner/wildplaces`). */
export function resolveRepo(config: StateConfig, project: string): string {
  if (config.repos.includes(project)) return project;
  const full = config.projects[project];
  if (full === undefined) {
    throw new Error(
      `Unknown project "${project}". Configured: ${Object.keys(config.projects).join(", ")}`
    );
  }
  return full;
}
