/**
 * The two things that would rot silently.
 *
 * 1. The zod schemas mirror `state/schema/*.json`. The JSON Schema is canonical
 *    — the routine obeys it, CI enforces it, tools/validate-state.js reads it —
 *    and zod exists only so the bot gets types and a pre-network check. If they
 *    drift, the bot happily writes something CI then rejects, and the task table
 *    is stuck until a human notices.
 *
 * 2. The glob matcher here and the one in tools/validate-state.js are separate
 *    implementations by necessity: that file must stay dependency-free CommonJS
 *    for the routine's sandbox. Both are run against the same case table here,
 *    so a divergence cannot be merged.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { taskSchema, claimSchema, userSchema, tasksDocSchema } from "../dist/schemas.js";
import { globsIntersect } from "../dist/glob.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const SCHEMA_DIR = join(REPO_ROOT, "state", "schema");

const require = createRequire(import.meta.url);
const validator = require(join(REPO_ROOT, "tools", "validate-state.js"));

const json = (name) => JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));

// --- 1. schema parity ------------------------------------------------------

test("zod task schema requires exactly the fields the JSON Schema requires", () => {
  const jsonSchema = json("task.json");
  const zodKeys = Object.keys(taskSchema.shape).sort();
  const jsonKeys = Object.keys(jsonSchema.properties).sort();
  assert.deepEqual(zodKeys, jsonKeys, "task field sets differ");
  assert.deepEqual([...jsonSchema.required].sort(), jsonKeys, "every task field should be required");
});

test("task state enum matches the JSON Schema exactly", () => {
  assert.deepEqual(taskSchema.shape.state.options, json("task.json").properties.state.enum);
});

test("task id pattern matches the JSON Schema", () => {
  // The JSON Schema writes [0-9]{3}; zod writes \d{3}. Compare behaviour, not text.
  const re = new RegExp(json("task.json").properties.id.pattern);
  for (const good of ["t-001", "t-999"]) {
    assert.ok(re.test(good), `${good} should match the JSON Schema`);
    assert.ok(taskSchema.shape.id.safeParse(good).success, `${good} should match zod`);
  }
  for (const bad of ["t-1", "t-0001", "T-001", "task-001", ""]) {
    assert.ok(!re.test(bad), `${bad} should not match the JSON Schema`);
    assert.ok(!taskSchema.shape.id.safeParse(bad).success, `${bad} should not match zod`);
  }
});

test("open_decisions must be non-empty in both schemas", () => {
  assert.equal(json("task.json").properties.open_decisions.minItems, 1);
  const task = {
    id: "t-001",
    title: "A title long enough",
    contract: {
      inputs: "something long enough",
      outputs: "something long enough",
      invariants: ["holds"],
      must_not_break: ["holds"],
    },
    open_decisions: [],
    touched_paths: ["src/**"],
    depends_on: [],
    issue: null,
    state: "open",
  };
  const result = taskSchema.safeParse(task);
  assert.ok(!result.success, "a task with no open decisions is not a task");
});

test("claim and user field sets match their JSON Schemas", () => {
  const claimProps = json("claims.json").properties.claims.items.properties;
  assert.deepEqual(Object.keys(claimSchema.shape).sort(), Object.keys(claimProps).sort());

  const userProps = json("users.json").properties.users.items.properties;
  assert.deepEqual(Object.keys(userSchema.shape).sort(), Object.keys(userProps).sort());
});

test("the trusted-user cap is five in both schemas", () => {
  assert.equal(json("users.json").properties.users.maxItems, 5);
});

test("both schemas reject unknown properties", () => {
  assert.equal(json("task.json").additionalProperties, false);
  const result = taskSchema.safeParse({
    id: "t-001",
    title: "A title long enough",
    contract: {
      inputs: "something long enough",
      outputs: "something long enough",
      invariants: ["holds"],
      must_not_break: ["holds"],
    },
    open_decisions: ["a genuine fork in the road"],
    touched_paths: ["src/**"],
    depends_on: [],
    issue: null,
    state: "open",
    surprise: "unexpected",
  });
  assert.ok(!result.success, "strict mode should reject an unknown key");
});

test("the committed task table parses under the zod schema", () => {
  // Not a hypothetical: this is the real file the routine appends to daily.
  const doc = JSON.parse(readFileSync(join(REPO_ROOT, "state", "tasks.json"), "utf8"));
  const result = tasksDocSchema.safeParse(doc);
  assert.ok(
    result.success,
    result.success ? "" : JSON.stringify(result.error.issues.slice(0, 5), null, 2)
  );
});

// --- 2. glob parity --------------------------------------------------------

const GLOB_CASES = [
  ["src/panel/**", "src/panel/foo.ts", true],
  ["src/panel/**", "src/panel/deep/nested/foo.ts", true],
  ["src/panel/**", "src/panel", true],
  ["src/**", "src/panel/foo.ts", true],
  ["**", "anything/at/all.ts", true],
  ["src/a/**", "src/b/**", false],
  ["src/panel/foo.ts", "src/panel/bar.ts", false],
  ["src/*.ts", "src/app.ts", true],
  ["src/*.ts", "src/nested/app.ts", false],
  ["src/*.ts", "src/app.js", false],
  ["src/**/*.ts", "src/a/b/c.ts", true],
  ["src/**/*.ts", "src/a/b/c.js", false],
  ["src/?pp.ts", "src/app.ts", true],
  ["src/?pp.ts", "src/aapp.ts", false],
  ["packages/state/**", "packages/bot/**", false],
  ["packages/*/src/**", "packages/state/src/index.ts", true],
  ["docs/**", "src/**", false],
  ["a/**/b", "a/b", true],
  ["a/**/b", "a/x/y/b", true],
  ["a/**/b", "a/x/y/c", false],
];

test("the TypeScript glob matcher agrees with tools/validate-state.js", () => {
  for (const [a, b, expected] of GLOB_CASES) {
    assert.equal(globsIntersect(a, b), expected, `ts: ${a} vs ${b}`);
    assert.equal(validator.globsIntersect(a, b), expected, `js: ${a} vs ${b}`);
    // Symmetry, both ways, in both implementations.
    assert.equal(globsIntersect(b, a), expected, `ts (reversed): ${b} vs ${a}`);
    assert.equal(validator.globsIntersect(b, a), expected, `js (reversed): ${b} vs ${a}`);
  }
});

test("the case the contract names by hand is handled", () => {
  // If this ever returns false, two people can claim the same code.
  assert.equal(globsIntersect("src/panel/**", "src/panel/foo.ts"), true);
  assert.equal(validator.globsIntersect("src/panel/**", "src/panel/foo.ts"), true);
});
