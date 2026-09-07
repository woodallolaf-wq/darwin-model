"use strict";

/* Smoke: does it RUN. Not: is it correct.
 *
 * Correctness against a task contract is judged by a human via
 * .claude/commands/verify.md. CI only proves the tree is not broken.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const STATE = path.join(ROOT, "state");

test("every state file is parseable JSON with its expected top-level key", () => {
  const expected = { "tasks.json": "tasks", "claims.json": "claims", "users.json": "users" };
  for (const [file, key] of Object.entries(expected)) {
    const doc = JSON.parse(fs.readFileSync(path.join(STATE, file), "utf8"));
    assert.ok(Array.isArray(doc[key]), `state/${file} should have an array at .${key}`);
  }
});

test("every schema file is parseable JSON", () => {
  const dir = path.join(STATE, "schema");
  const schemas = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(schemas.length >= 4, "expected at least four schema files");
  for (const f of schemas) {
    JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  }
});

test("the validator module loads and exports the glob matcher", () => {
  const { globsIntersect } = require("../../tools/validate-state.js");
  assert.strictEqual(typeof globsIntersect, "function");
});

test("glob intersection catches the directory-vs-file case the bot depends on", () => {
  const { globsIntersect } = require("../../tools/validate-state.js");
  // If this ever returns false, two people can claim the same code.
  assert.strictEqual(globsIntersect("src/panel/**", "src/panel/foo.ts"), true);
  assert.strictEqual(globsIntersect("src/a/**", "src/b/**"), false);
});

test("committed state passes full validation", () => {
  const { execFileSync } = require("child_process");
  execFileSync(process.execPath, [path.join(ROOT, "tools", "validate-state.js"), "--quiet"], {
    cwd: ROOT,
    stdio: "pipe"
  });
});
