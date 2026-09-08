#!/usr/bin/env node
/* Preflight for .env — check every credential the bot will need, before the
 * bot exists to fail on them.
 *
 * Dependency-free: Node 22's built-in fetch, no npm install.
 *
 *   node tools/check-credentials.mjs
 *
 * Exits 0 if everything the bot needs is present and working, 1 otherwise.
 * Secret values are never printed — only what they can and cannot do.
 *
 * The GitHub write test creates a throwaway git ref and deletes it again, so
 * it proves Contents:write without leaving anything behind. Note that the
 * `permissions.push` field on the repo object reflects YOUR access, not the
 * token's, so it will happily say `true` for a read-only token. Only an actual
 * write attempt tells you the truth.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- tiny .env parser ------------------------------------------------------
function loadEnv() {
  let raw;
  try {
    raw = readFileSync(join(ROOT, ".env"), "utf8");
  } catch {
    console.error("No .env found. Copy .env.example to .env and fill it in.");
    console.error("See docs/discord-setup.md.");
    process.exit(1);
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

// --- reporting -------------------------------------------------------------
const results = [];
function record(name, ok, detail, fatal = true) {
  results.push({ name, ok, detail, fatal });
  const mark = ok ? "PASS" : fatal ? "FAIL" : "warn";
  console.log(`  [${mark}] ${name}${detail ? " — " + detail : ""}`);
}

// --- Discord ---------------------------------------------------------------
const DISCORD_EPOCH = 1420070400000n;

function snowflakeDate(id) {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

function checkSnowflake(name, value) {
  if (!value) return record(name, false, "not set");
  if (!/^\d{17,20}$/.test(value)) {
    return record(name, false, `"${value}" is not a snowflake (17-20 digits)`);
  }
  record(name, true, `created ${snowflakeDate(value).toISOString().slice(0, 16).replace("T", " ")}Z`);
}

async function discordApi(token, path) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty body is fine */
  }
  return { status: res.status, body };
}

async function checkDiscord(env) {
  console.log("\nDiscord");

  checkSnowflake("guild id", env.DISCORD_GUILD_ID);
  checkSnowflake("channel #start", env.DISCORD_CHANNEL_START);
  checkSnowflake("channel #code", env.DISCORD_CHANNEL_CODE);
  checkSnowflake("channel #merged", env.DISCORD_CHANNEL_MERGED);

  const ids = [env.DISCORD_CHANNEL_START, env.DISCORD_CHANNEL_CODE, env.DISCORD_CHANNEL_MERGED];
  if (ids.every(Boolean)) {
    record("channels are distinct", new Set(ids).size === 3, new Set(ids).size === 3 ? "" : "duplicate ids");
  }

  if (!env.DISCORD_TOKEN) {
    record("bot token", false, "not set — Developer Portal > Bot > Reset Token");
    return;
  }

  const me = await discordApi(env.DISCORD_TOKEN, "/users/@me");
  if (me.status !== 200) {
    return record("bot token", false, `HTTP ${me.status} ${me.body?.message ?? ""} (a bad or reset token)`);
  }
  record("bot token", true, `authenticated as ${me.body.username} (${me.body.id})`);

  if (env.DISCORD_APPLICATION_ID && env.DISCORD_APPLICATION_ID !== me.body.id) {
    record(
      "application id matches bot",
      false,
      `.env says ${env.DISCORD_APPLICATION_ID}, token belongs to ${me.body.id}`
    );
  } else if (env.DISCORD_APPLICATION_ID) {
    record("application id matches bot", true, "");
  } else {
    record("application id", false, "not set — General Information > Application ID");
  }

  if (env.DISCORD_GUILD_ID) {
    const g = await discordApi(env.DISCORD_TOKEN, `/guilds/${env.DISCORD_GUILD_ID}`);
    if (g.status === 200) {
      record("bot is in the server", true, `"${g.body.name}"`);
    } else {
      record(
        "bot is in the server",
        false,
        `HTTP ${g.status} — invite it with the OAuth2 URL in docs/discord-setup.md`
      );
    }
  }

  for (const [label, id] of [
    ["#start", env.DISCORD_CHANNEL_START],
    ["#code", env.DISCORD_CHANNEL_CODE],
    ["#merged", env.DISCORD_CHANNEL_MERGED],
  ]) {
    if (!id) continue;
    const c = await discordApi(env.DISCORD_TOKEN, `/channels/${id}`);
    if (c.status === 200) {
      const inGuild = !env.DISCORD_GUILD_ID || c.body.guild_id === env.DISCORD_GUILD_ID;
      record(
        `bot can see ${label}`,
        inGuild,
        inGuild ? `#${c.body.name}` : `#${c.body.name} is in a different server`
      );
    } else {
      record(`bot can see ${label}`, false, `HTTP ${c.status} — check the channel id and bot permissions`);
    }
  }
}

// --- GitHub ----------------------------------------------------------------
async function githubApi(token, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 204 has no body */
  }
  return { status: res.status, body };
}

async function checkGitHub(env) {
  console.log("\nGitHub");

  if (!env.GITHUB_TOKEN) {
    return record("token", false, "not set");
  }

  const me = await githubApi(env.GITHUB_TOKEN, "/user");
  if (me.status !== 200) {
    return record("token", false, `HTTP ${me.status} ${me.body?.message ?? ""}`);
  }
  record("token", true, `authenticated as ${me.body.login}`);

  const repos = (env.GITHUB_REPOS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!repos.length) return record("GITHUB_REPOS", false, "not set");

  for (const repo of repos) {
    const r = await githubApi(env.GITHUB_TOKEN, `/repos/${repo}`);
    if (r.status !== 200) {
      record(
        `${repo} — access`,
        false,
        r.status === 404
          ? "404: the token has no grant for this repo (fine-grained tokens 404 rather than 403)"
          : `HTTP ${r.status} ${r.body?.message ?? ""}`
      );
      continue;
    }
    record(`${repo} — read`, true, r.body.private ? "private" : "public");

    // The real test. Create a throwaway ref, then delete it. `permissions.push`
    // on the repo object is about YOU, not the token, so it cannot be trusted.
    const head = await githubApi(env.GITHUB_TOKEN, `/repos/${repo}/git/ref/heads/main`);
    if (head.status !== 200) {
      record(`${repo} — write`, false, "could not read refs/heads/main");
      continue;
    }
    const ref = `refs/heads/credcheck-${Date.now()}`;
    const created = await githubApi(env.GITHUB_TOKEN, `/repos/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref, sha: head.body.object.sha }),
    });
    if (created.status === 201) {
      const del = await githubApi(
        env.GITHUB_TOKEN,
        `/repos/${repo}/git/${ref.replace("refs/", "refs/")}`,
        { method: "DELETE" }
      );
      record(
        `${repo} — contents:write`,
        true,
        del.status === 204 ? "verified, test ref removed" : `verified, but cleanup returned ${del.status}`
      );
    } else {
      record(
        `${repo} — contents:write`,
        false,
        `HTTP ${created.status} ${created.body?.message ?? ""} — set Contents to "Read and write" on the token`
      );
    }
  }
}

// --- main ------------------------------------------------------------------
const env = loadEnv();
console.log("Checking .env — secret values are never printed.");
await checkDiscord(env);
await checkGitHub(env);

const failed = results.filter((r) => !r.ok && r.fatal);
console.log("");
if (failed.length) {
  console.log(`${failed.length} of ${results.length} checks failed. The bot will not work until they pass:`);
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  console.log("\nSee docs/discord-setup.md.");
  process.exit(1);
}
console.log(`All ${results.length} checks passed. Credentials are ready.`);
