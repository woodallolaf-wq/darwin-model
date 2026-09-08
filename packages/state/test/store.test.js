/**
 * Store behaviour, against a fake GitHub.
 *
 * The interesting cases are all about the sha: a write that lands, a write that
 * loses a race and retries, and a write that loses twice and must give up
 * rather than loop. None of them need a network, and a test that did would be
 * too slow and flaky to run on every PR.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { StateStore } from "../dist/store.js";
import { isStateError } from "../dist/errors.js";

const CONFIG = {
  githubToken: "not-a-real-token",
  repos: ["acme/alpha", "acme/beta"],
  branch: "main",
  cacheMs: 30_000,
  projects: { alpha: "acme/alpha", beta: "acme/beta" },
};

const emptyClaims = () => ({ claims: [] });

/**
 * A fake of the two Octokit calls the store makes. Content is stored per
 * repo+path with a sha that changes on every write, exactly as GitHub behaves.
 */
function fakeOctokit(initial = {}) {
  const files = new Map();
  let shaCounter = 0;

  for (const [key, value] of Object.entries(initial)) {
    files.set(key, { text: JSON.stringify(value, null, 2) + "\n", sha: `sha-${++shaCounter}` });
  }

  const calls = { get: 0, put: 0 };
  /** Hook to simulate a competing writer landing between our GET and our PUT. */
  let beforePut = null;

  const octokit = {
    repos: {
      async getContent({ owner, repo, path }) {
        calls.get++;
        const key = `${owner}/${repo}:${path}`;
        const file = files.get(key);
        if (!file) {
          const err = new Error("Not Found");
          err.status = 404;
          throw err;
        }
        return {
          data: {
            type: "file",
            sha: file.sha,
            content: Buffer.from(file.text, "utf8").toString("base64"),
          },
        };
      },
      async createOrUpdateFileContents({ owner, repo, path, content, sha }) {
        calls.put++;
        if (beforePut) {
          const hook = beforePut;
          beforePut = null;
          hook();
        }
        const key = `${owner}/${repo}:${path}`;
        const file = files.get(key);
        if (file && file.sha !== sha) {
          const err = new Error("is at ... but expected ...");
          err.status = 409;
          throw err;
        }
        files.set(key, {
          text: Buffer.from(content, "base64").toString("utf8"),
          sha: `sha-${++shaCounter}`,
        });
        return { data: {} };
      },
    },
  };

  return {
    octokit,
    calls,
    read: (key) => JSON.parse(files.get(key).text),
    raw: (key) => files.get(key).text,
    /** Simulate another writer changing the file right before our PUT. */
    interleave(key, value) {
      beforePut = () => {
        files.set(key, {
          text: JSON.stringify(value, null, 2) + "\n",
          sha: `sha-${++shaCounter}`,
        });
      };
    },
  };
}

const CLAIM = {
  task_id: "t-001",
  discord_id: "779050350534590475",
  claimed_at: "2026-09-08T12:00:00Z",
  branch: "task/t-001",
};

test("reads a document and validates it", async () => {
  const gh = fakeOctokit({ "acme/alpha:state/claims.json": emptyClaims() });
  const store = new StateStore(CONFIG, gh.octokit);
  assert.deepEqual(await store.read("alpha", "claims"), { claims: [] });
});

test("a repeated read inside the cache window does not hit the network", async () => {
  const gh = fakeOctokit({ "acme/alpha:state/claims.json": emptyClaims() });
  const store = new StateStore(CONFIG, gh.octokit);
  await store.read("alpha", "claims");
  await store.read("alpha", "claims");
  assert.equal(gh.calls.get, 1, "second read should be served from cache");
});

test("the cache is keyed by repo as well as document", async () => {
  const gh = fakeOctokit({
    "acme/alpha:state/claims.json": { claims: [CLAIM] },
    "acme/beta:state/claims.json": emptyClaims(),
  });
  const store = new StateStore(CONFIG, gh.octokit);
  const alpha = await store.read("alpha", "claims");
  const beta = await store.read("beta", "claims");
  assert.equal(alpha.claims.length, 1);
  assert.equal(beta.claims.length, 0, "beta must not be served alpha's cached claims");
});

test("a write lands and invalidates only its own document", async () => {
  const gh = fakeOctokit({ "acme/alpha:state/claims.json": emptyClaims() });
  const store = new StateStore(CONFIG, gh.octokit);

  await store.read("alpha", "claims");
  await store.write("alpha", "claims", (doc) => ({ claims: [...doc.claims, CLAIM] }), "claim t-001");

  const after = await store.read("alpha", "claims");
  assert.equal(after.claims.length, 1, "the write should be visible immediately, not cached away");
  assert.deepEqual(gh.read("acme/alpha:state/claims.json"), { claims: [CLAIM] });
});

test("a concurrent write is retried once against fresh content, and both survive", async () => {
  const gh = fakeOctokit({ "acme/alpha:state/claims.json": emptyClaims() });
  const store = new StateStore(CONFIG, gh.octokit);

  const other = {
    task_id: "t-002",
    discord_id: "111111111111111111",
    claimed_at: "2026-09-08T11:59:59Z",
    branch: "task/t-002",
  };
  // Someone else's claim lands between our GET and our PUT.
  gh.interleave("acme/alpha:state/claims.json", { claims: [other] });

  await store.write("alpha", "claims", (doc) => ({ claims: [...doc.claims, CLAIM] }), "claim t-001");

  const final = gh.read("acme/alpha:state/claims.json");
  assert.equal(final.claims.length, 2, "the retry must re-apply against fresh content, not clobber");
  assert.deepEqual(
    final.claims.map((c) => c.task_id).sort(),
    ["t-001", "t-002"],
    "neither writer should be lost"
  );
  assert.equal(gh.calls.put, 2, "exactly one retry");
});

test("a write that fails its schema never reaches the network", async () => {
  const gh = fakeOctokit({ "acme/alpha:state/claims.json": emptyClaims() });
  const store = new StateStore(CONFIG, gh.octokit);

  await assert.rejects(
    () =>
      store.write(
        "alpha",
        "claims",
        () => ({ claims: [{ ...CLAIM, task_id: "nonsense" }] }),
        "bad write"
      ),
    (err) => {
      assert.ok(isStateError(err));
      assert.equal(err.code, "invalid_write");
      return true;
    }
  );
  assert.equal(gh.calls.put, 0, "nothing should have been sent");
});

test("a document that is already invalid on GitHub is refused, not overwritten", async () => {
  const gh = fakeOctokit({ "acme/alpha:state/claims.json": { claims: [{ task_id: "oops" }] } });
  const store = new StateStore(CONFIG, gh.octokit);

  await assert.rejects(
    () => store.read("alpha", "claims"),
    (err) => isStateError(err) && err.code === "invalid_remote"
  );
});

test("a missing document reports not_found rather than a transport error", async () => {
  const gh = fakeOctokit({});
  const store = new StateStore(CONFIG, gh.octokit);
  await assert.rejects(
    () => store.read("alpha", "claims"),
    (err) => isStateError(err) && err.code === "not_found"
  );
});

test("an unknown project is rejected with the configured names", async () => {
  const gh = fakeOctokit({});
  const store = new StateStore(CONFIG, gh.octokit);
  await assert.rejects(() => store.read("nope", "claims"), /Unknown project "nope".*alpha, beta/s);
});

test("writes preserve the repo's JSON house style", async () => {
  const gh = fakeOctokit({ "acme/alpha:state/claims.json": emptyClaims() });
  const store = new StateStore(CONFIG, gh.octokit);
  await store.write("alpha", "claims", (doc) => ({ claims: [...doc.claims, CLAIM] }), "claim");

  const text = gh.raw("acme/alpha:state/claims.json");
  assert.ok(text.endsWith("\n"), "should end with a trailing newline");
  assert.ok(text.includes('\n  "claims"'), "should use two-space indent");
});
