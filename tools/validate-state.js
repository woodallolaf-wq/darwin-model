#!/usr/bin/env node
/* Validate state/tasks.json, state/claims.json and state/users.json.
 *
 * Nothing writes to state/ without passing this first. The daily routine runs
 * it before it commits and abandons the commit on any error; CI runs it on
 * every PR. It is the reason a malformed task table cannot reach main.
 *
 * Deliberately dependency-free — plain Node, no npm install, no zod. The
 * routine runs in a fresh sandbox every day; anything it has to install is
 * another thing that can fail at 08:47. The zod schemas in packages/state are
 * a mirror of state/schema/*.json for the bot's benefit, not a replacement
 * for this.
 *
 * Usage:
 *   node tools/validate-state.js              # validate, print a summary
 *   node tools/validate-state.js --check      # same (this tool never writes)
 *   node tools/validate-state.js --quiet      # errors only, no summary
 *   node tools/validate-state.js --self-test  # unit-test the glob matcher
 *
 * Exit code is 0 when valid, 1 on any error.
 */

"use strict";

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var STATE_DIR = path.join(ROOT, "state");
var SCHEMA_DIR = path.join(STATE_DIR, "schema");

// A task in one of these states owns its touched_paths. Two of them may not
// overlap, or two people are editing the same files with different contracts.
var ACTIVE_STATES = ["open", "claimed", "in_review"];

// ---------------------------------------------------------------------------
// Glob intersection
//
// The only genuinely subtle logic in the system: given two path globs, could
// any single concrete file match both? Used to stop two live tasks owning the
// same code. The Discord bot's /task must use the same rule.
//
// Both halves are language-intersection over the glob alphabet, memoised so
// the recursion stays polynomial:
//   segmentsIntersect  handles  **  across path segments
//   charsIntersect     handles  *  and  ?  within one segment
// ---------------------------------------------------------------------------
function splitGlob(g) {
  return String(g)
    .split("/")
    .filter(function (s) {
      return s.length > 0;
    });
}

function charsIntersect(a, b) {
  var memo = new Map();

  function go(i, j) {
    var key = i * (b.length + 1) + j;
    if (memo.has(key)) return memo.get(key);

    var result;
    if (i === a.length && j === b.length) {
      result = true;
    } else if (i === a.length) {
      // a is exhausted; b can only still match if the rest is all '*'
      result = b.slice(j).split("").every(function (c) {
        return c === "*";
      });
    } else if (j === b.length) {
      result = a.slice(i).split("").every(function (c) {
        return c === "*";
      });
    } else if (a[i] === "*") {
      // '*' matches zero characters, or one more character of b
      result = go(i + 1, j) || go(i, j + 1);
    } else if (b[j] === "*") {
      result = go(i, j + 1) || go(i + 1, j);
    } else if (a[i] === "?" || b[j] === "?" || a[i] === b[j]) {
      result = go(i + 1, j + 1);
    } else {
      result = false;
    }

    memo.set(key, result);
    return result;
  }

  return go(0, 0);
}

function segmentsIntersect(a, b) {
  var memo = new Map();

  function allDoubleStar(segs) {
    return segs.every(function (s) {
      return s === "**";
    });
  }

  function go(i, j) {
    var key = i * (b.length + 1) + j;
    if (memo.has(key)) return memo.get(key);

    var result;
    if (i === a.length && j === b.length) {
      result = true;
    } else if (i === a.length) {
      // '**' matches zero segments, so a trailing run of '**' still matches
      result = allDoubleStar(b.slice(j));
    } else if (j === b.length) {
      result = allDoubleStar(a.slice(i));
    } else if (a[i] === "**") {
      result = go(i + 1, j) || go(i, j + 1);
    } else if (b[j] === "**") {
      result = go(i, j + 1) || go(i + 1, j);
    } else {
      result = charsIntersect(a[i], b[j]) && go(i + 1, j + 1);
    }

    memo.set(key, result);
    return result;
  }

  return go(0, 0);
}

function globsIntersect(g1, g2) {
  return segmentsIntersect(splitGlob(g1), splitGlob(g2));
}

// ---------------------------------------------------------------------------
// A very small JSON Schema validator — only the keywords state/schema/*.json
// actually use. It fails closed: an unknown keyword is ignored, but every
// keyword listed here is enforced.
// ---------------------------------------------------------------------------
var schemaCache = new Map();

function loadSchema(name) {
  if (schemaCache.has(name)) return schemaCache.get(name);
  var file = path.join(SCHEMA_DIR, name);
  var parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error("could not read schema " + name + ": " + e.message);
  }
  schemaCache.set(name, parsed);
  return parsed;
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function typeMatches(v, t) {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number";
  return typeOf(v) === t;
}

function validate(value, schema, where, errors) {
  if (schema.$ref) {
    validate(value, loadSchema(schema.$ref), where, errors);
    return;
  }

  if (schema.type !== undefined) {
    var types = Array.isArray(schema.type) ? schema.type : [schema.type];
    var ok = types.some(function (t) {
      return typeMatches(value, t);
    });
    if (!ok) {
      errors.push(where + ": expected " + types.join(" or ") + ", got " + typeOf(value));
      return; // every other keyword assumes the type held
    }
  }

  if (schema.enum !== undefined) {
    var found = schema.enum.some(function (e) {
      return e === value;
    });
    if (!found) {
      errors.push(
        where + ": " + JSON.stringify(value) + " is not one of " + schema.enum.join(", ")
      );
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(
        where + ": too short (" + value.length + " chars, needs " + schema.minLength + ")"
      );
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(
        where + ": too long (" + value.length + " chars, max " + schema.maxLength + ")"
      );
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(where + ": " + JSON.stringify(value) + " does not match " + schema.pattern);
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(where + ": must be >= " + schema.minimum);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(
        where +
          ": needs at least " +
          schema.minItems +
          " item(s), has " +
          value.length +
          (schema.minItems === 1 ? " — an empty list is not acceptable here" : "")
      );
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(where + ": at most " + schema.maxItems + " item(s), has " + value.length);
    }
    if (schema.items) {
      value.forEach(function (item, i) {
        validate(item, schema.items, where + "[" + i + "]", errors);
      });
    }
  }

  if (value && typeOf(value) === "object") {
    (schema.required || []).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(where + ": missing required property '" + key + "'");
      }
    });

    var props = schema.properties || {};
    if (schema.additionalProperties === false) {
      Object.keys(value).forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          errors.push(where + ": unexpected property '" + key + "'");
        }
      });
    }

    Object.keys(props).forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validate(value[key], props[key], where + "." + key, errors);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Cross-file rules — the things a per-file schema cannot express
// ---------------------------------------------------------------------------
function checkTasks(tasks, errors) {
  var seenIds = Object.create(null);
  var seenIssues = Object.create(null);

  tasks.forEach(function (t, i) {
    var where = "tasks[" + i + "] " + (t && t.id ? t.id : "(no id)");

    if (!t || !t.id) return;

    if (seenIds[t.id]) {
      errors.push(where + ": duplicate task id");
    }
    seenIds[t.id] = true;

    if (typeof t.issue === "number") {
      if (seenIssues[t.issue]) {
        errors.push(where + ": issue #" + t.issue + " is already used by " + seenIssues[t.issue]);
      }
      seenIssues[t.issue] = t.id;
    }
  });

  tasks.forEach(function (t, i) {
    var where = "tasks[" + i + "] " + (t && t.id ? t.id : "(no id)");
    if (!t || !Array.isArray(t.depends_on)) return;

    t.depends_on.forEach(function (dep) {
      if (dep === t.id) {
        errors.push(where + ": depends on itself");
      } else if (!seenIds[dep]) {
        errors.push(where + ": depends_on '" + dep + "' does not exist");
      }
    });
  });

  // touched_paths must not overlap between two simultaneously-active tasks
  var active = tasks.filter(function (t) {
    return t && ACTIVE_STATES.indexOf(t.state) !== -1 && Array.isArray(t.touched_paths);
  });

  for (var a = 0; a < active.length; a++) {
    for (var b = a + 1; b < active.length; b++) {
      var ta = active[a];
      var tb = active[b];

      // A dependency edge means they are sequenced, not concurrent, so they
      // are allowed to share paths.
      var sequenced =
        (ta.depends_on || []).indexOf(tb.id) !== -1 ||
        (tb.depends_on || []).indexOf(ta.id) !== -1;
      if (sequenced) continue;

      ta.touched_paths.forEach(function (pa) {
        tb.touched_paths.forEach(function (pb) {
          if (globsIntersect(pa, pb)) {
            errors.push(
              ta.id +
                " and " +
                tb.id +
                " are both active and their touched_paths overlap: '" +
                pa +
                "' vs '" +
                pb +
                "'"
            );
          }
        });
      });
    }
  }
}

function checkClaims(claims, tasks, users, errors) {
  var taskById = Object.create(null);
  tasks.forEach(function (t) {
    if (t && t.id) taskById[t.id] = t;
  });

  var knownDiscordIds = Object.create(null);
  users.forEach(function (u) {
    if (u && u.discord_id) knownDiscordIds[u.discord_id] = true;
  });

  var claimedTasks = Object.create(null);
  var claimants = Object.create(null);

  claims.forEach(function (c, i) {
    var where = "claims[" + i + "]";
    if (!c) return;

    var task = taskById[c.task_id];
    if (!task) {
      errors.push(where + ": claims '" + c.task_id + "', which is not in tasks.json");
    } else if (task.state !== "claimed" && task.state !== "in_review") {
      errors.push(
        where +
          ": claims " +
          c.task_id +
          ", but that task's state is '" +
          task.state +
          "' (expected claimed or in_review)"
      );
    }

    if (c.discord_id && !knownDiscordIds[c.discord_id]) {
      errors.push(where + ": discord_id " + c.discord_id + " is not in users.json");
    }

    if (c.task_id && claimedTasks[c.task_id]) {
      errors.push(where + ": " + c.task_id + " is claimed twice");
    }
    claimedTasks[c.task_id] = true;

    if (c.discord_id && claimants[c.discord_id]) {
      errors.push(
        where + ": " + c.discord_id + " holds more than one claim (" + claimants[c.discord_id] + " and " + c.task_id + ")"
      );
    }
    claimants[c.discord_id] = c.task_id;

    if (c.branch && c.task_id && c.branch !== "task/" + c.task_id) {
      errors.push(where + ": branch '" + c.branch + "' should be 'task/" + c.task_id + "'");
    }
  });

  // The reverse direction: a claimed task with no claim is a leak.
  tasks.forEach(function (t) {
    if (!t) return;
    if ((t.state === "claimed" || t.state === "in_review") && !claimedTasks[t.id]) {
      errors.push(t.id + ": state is '" + t.state + "' but nothing in claims.json holds it");
    }
    if ((t.state === "merged" || t.state === "rejected") && claimedTasks[t.id]) {
      errors.push(t.id + ": state is '" + t.state + "' but a claim is still open on it");
    }
  });
}

function checkUsers(users, errors) {
  var seen = Object.create(null);
  users.forEach(function (u, i) {
    if (!u || !u.discord_id) return;
    if (seen[u.discord_id]) {
      errors.push("users[" + i + "]: duplicate discord_id " + u.discord_id);
    }
    seen[u.discord_id] = true;
  });
}

// ---------------------------------------------------------------------------
// Self-test for the glob matcher — the one piece of logic subtle enough to
// get quietly wrong. Runs in CI so a refactor cannot silently break claim
// collision detection.
// ---------------------------------------------------------------------------
function selfTest() {
  var cases = [
    // [a, b, shouldIntersect]
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
    ["a/**/b", "a/x/y/c", false]
  ];

  var failures = 0;
  cases.forEach(function (c) {
    var got = globsIntersect(c[0], c[1]);
    var also = globsIntersect(c[1], c[0]); // must be symmetric
    if (got !== c[2]) {
      console.error("FAIL: '" + c[0] + "' vs '" + c[1] + "' expected " + c[2] + ", got " + got);
      failures++;
    }
    if (also !== got) {
      console.error("FAIL: '" + c[0] + "' vs '" + c[1] + "' is not symmetric");
      failures++;
    }
  });

  if (failures) {
    console.error(failures + " glob test(s) failed.");
    process.exit(1);
  }
  console.log("glob matcher: " + cases.length + " cases passed (both directions).");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function readState(name, errors) {
  var file = path.join(STATE_DIR, name);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    errors.push("state/" + name + ": " + e.message);
    return null;
  }
}

function main() {
  var args = process.argv.slice(2);
  var quiet = args.indexOf("--quiet") !== -1;

  if (args.indexOf("--self-test") !== -1) {
    selfTest();
    return;
  }

  var errors = [];

  var tasksDoc = readState("tasks.json", errors);
  var claimsDoc = readState("claims.json", errors);
  var usersDoc = readState("users.json", errors);

  if (errors.length) {
    report(errors);
    return;
  }

  validate(tasksDoc, loadSchema("tasks.json"), "tasks.json", errors);
  validate(claimsDoc, loadSchema("claims.json"), "claims.json", errors);
  validate(usersDoc, loadSchema("users.json"), "users.json", errors);

  // Cross-file rules only make sense on structurally sound documents.
  if (!errors.length) {
    checkTasks(tasksDoc.tasks, errors);
    checkUsers(usersDoc.users, errors);
    checkClaims(claimsDoc.claims, tasksDoc.tasks, usersDoc.users, errors);
  }

  if (errors.length) {
    report(errors);
    return;
  }

  if (!quiet) {
    var byState = {};
    tasksDoc.tasks.forEach(function (t) {
      byState[t.state] = (byState[t.state] || 0) + 1;
    });
    var order = ["open", "claimed", "in_review", "merged", "rejected"];
    console.log("state/ is valid.");
    console.log(
      "  tasks: " +
        tasksDoc.tasks.length +
        " (" +
        order
          .map(function (s) {
            return s + " " + (byState[s] || 0);
          })
          .join(", ") +
        ")"
    );
    console.log("  claims: " + claimsDoc.claims.length);
    console.log("  users: " + usersDoc.users.length);

    var withoutIssue = tasksDoc.tasks.filter(function (t) {
      return t.issue === null;
    }).length;
    if (withoutIssue) {
      console.log(
        "  note: " + withoutIssue + " task(s) have no GitHub issue — see if `gh` failed on the run that added them"
      );
    }

    // Valid but not yet real. Loud, deliberately not an error: CI should stay
    // green while the repo is still being set up.
    var placeholders = usersDoc.users.filter(function (u) {
      return /^0+$/.test(u.discord_id);
    });
    if (placeholders.length) {
      console.log(
        "  WARNING: " +
          placeholders.length +
          " user(s) still have a placeholder discord_id (" +
          placeholders
            .map(function (u) {
              return u.github_login;
            })
            .join(", ") +
          "). The bot will not recognise them. Fill in state/users.json before /task goes live."
      );
    }
  }
}

function report(errors) {
  console.error("state/ is INVALID — " + errors.length + " problem(s):");
  errors.slice(0, 60).forEach(function (e) {
    console.error("  - " + e);
  });
  if (errors.length > 60) {
    console.error("  ... and " + (errors.length - 60) + " more");
  }
  process.exit(1);
}

module.exports = { globsIntersect: globsIntersect };

if (require.main === module) {
  main();
}
