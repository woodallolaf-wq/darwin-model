/**
 * The endpoint is public, so signature verification is the only thing between
 * the internet and the task table. These tests sign real requests with a real
 * Ed25519 keypair and assert that forged ones are refused.
 *
 * Discord itself probes a new endpoint with deliberately invalid signatures and
 * refuses to save it unless they get a 401 — so this is also what makes the URL
 * accepted at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { verifyRequest } from "../dist/discord/verify.js";
import { createHandler } from "../dist/http.js";

// Node exposes WebCrypto as a named export; the handler expects it global.
globalThis.crypto ??= webcrypto;

const ENV = {
  DISCORD_TOKEN: "not-a-real-token",
  DISCORD_APPLICATION_ID: "1546968884811272224",
  DISCORD_GUILD_ID: "1546336547534667876",
  DISCORD_CHANNEL_START: "1546956372783145100",
  DISCORD_CHANNEL_CODE: "1546956561279221821",
  DISCORD_CHANNEL_MERGED: "1546956814258671618",
  GITHUB_TOKEN: "not-a-real-token",
  GITHUB_REPOS: "acme/alpha,acme/beta",
};

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeKeypair() {
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = await webcrypto.subtle.exportKey("raw", pair.publicKey);
  return { pair, publicKeyHex: hex(raw) };
}

async function sign(privateKey, timestamp, body) {
  const message = new TextEncoder().encode(timestamp + body);
  return hex(await webcrypto.subtle.sign("Ed25519", privateKey, message));
}

function request(body, headers) {
  return new Request("https://example.com/interactions", { method: "POST", body, headers });
}

test("a correctly signed request verifies", async () => {
  const { pair, publicKeyHex } = await makeKeypair();
  const body = JSON.stringify({ type: 1 });
  const timestamp = "1757000000";
  const signatureHex = await sign(pair.privateKey, timestamp, body);

  assert.equal(await verifyRequest({ publicKeyHex, signatureHex, timestamp, body }), true);
});

test("a tampered body fails verification", async () => {
  const { pair, publicKeyHex } = await makeKeypair();
  const timestamp = "1757000000";
  const signatureHex = await sign(pair.privateKey, timestamp, JSON.stringify({ type: 1 }));

  const tampered = JSON.stringify({ type: 2, data: { name: "task" } });
  assert.equal(
    await verifyRequest({ publicKeyHex, signatureHex, timestamp, body: tampered }),
    false
  );
});

test("a replayed signature under a different timestamp fails", async () => {
  const { pair, publicKeyHex } = await makeKeypair();
  const body = JSON.stringify({ type: 1 });
  const signatureHex = await sign(pair.privateKey, "1757000000", body);

  assert.equal(
    await verifyRequest({ publicKeyHex, signatureHex, timestamp: "1757009999", body }),
    false
  );
});

test("a signature from the wrong key fails", async () => {
  const a = await makeKeypair();
  const b = await makeKeypair();
  const body = JSON.stringify({ type: 1 });
  const timestamp = "1757000000";
  const signatureHex = await sign(a.pair.privateKey, timestamp, body);

  assert.equal(
    await verifyRequest({ publicKeyHex: b.publicKeyHex, signatureHex, timestamp, body }),
    false
  );
});

test("garbage signatures are refused rather than throwing", async () => {
  const { publicKeyHex } = await makeKeypair();
  for (const signatureHex of ["", "zz", "not-hex-at-all", "ab".repeat(64)]) {
    assert.equal(
      await verifyRequest({ publicKeyHex, signatureHex, timestamp: "1", body: "{}" }),
      false,
      `should refuse ${JSON.stringify(signatureHex)}`
    );
  }
});

// --- the handler -----------------------------------------------------------

test("an unsigned POST is answered 401 and does nothing", async () => {
  const { publicKeyHex } = await makeKeypair();
  const handle = createHandler({ ...ENV, DISCORD_PUBLIC_KEY: publicKeyHex });

  let deferred = 0;
  const res = await handle(request(JSON.stringify({ type: 1 }), {}), () => deferred++);

  assert.equal(res.status, 401);
  assert.equal(deferred, 0, "nothing should have been scheduled");
});

test("a signed PING is answered with a PONG", async () => {
  const { pair, publicKeyHex } = await makeKeypair();
  const handle = createHandler({ ...ENV, DISCORD_PUBLIC_KEY: publicKeyHex });

  const body = JSON.stringify({ type: 1 });
  const timestamp = "1757000000";
  const res = await handle(
    request(body, {
      "x-signature-ed25519": await sign(pair.privateKey, timestamp, body),
      "x-signature-timestamp": timestamp,
    }),
    () => {}
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { type: 1 });
});

test("a command is acknowledged deferred and ephemeral, with the work handed off", async () => {
  const { pair, publicKeyHex } = await makeKeypair();
  const handle = createHandler({ ...ENV, DISCORD_PUBLIC_KEY: publicKeyHex });

  const body = JSON.stringify({
    id: "1",
    type: 2,
    token: "interaction-token",
    application_id: ENV.DISCORD_APPLICATION_ID,
    data: { id: "c", name: "task", options: [{ name: "project", type: 3, value: "alpha" }] },
    member: { user: { id: "779050350534590475", username: "olaf" } },
  });
  const timestamp = "1757000000";

  const scheduled = [];
  const res = await handle(
    request(body, {
      "x-signature-ed25519": await sign(pair.privateKey, timestamp, body),
      "x-signature-timestamp": timestamp,
    }),
    (work) => scheduled.push(work)
  );

  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.type, 5, "type 5 is the deferred acknowledgement");
  assert.equal(payload.data.flags, 64, "/task replies only to the caller");
  assert.equal(scheduled.length, 1, "the GitHub work should be deferred, not awaited");

  // The deferred work will fail against fake credentials — what matters is that
  // it is caught and never rejects, or the platform logs an unhandled rejection.
  await assert.doesNotReject(scheduled[0]);
});

test("/board is public rather than ephemeral", async () => {
  const { pair, publicKeyHex } = await makeKeypair();
  const handle = createHandler({ ...ENV, DISCORD_PUBLIC_KEY: publicKeyHex });

  const body = JSON.stringify({
    id: "1",
    type: 2,
    token: "t",
    application_id: ENV.DISCORD_APPLICATION_ID,
    data: { id: "c", name: "board" },
    member: { user: { id: "779050350534590475", username: "olaf" } },
  });
  const timestamp = "1757000000";

  const res = await handle(
    request(body, {
      "x-signature-ed25519": await sign(pair.privateKey, timestamp, body),
      "x-signature-timestamp": timestamp,
    }),
    () => {}
  );

  const payload = await res.json();
  assert.equal(payload.type, 5);
  assert.equal(payload.data, undefined, "no ephemeral flag");
});

test("a GET is refused without touching the signature path", async () => {
  const { publicKeyHex } = await makeKeypair();
  const handle = createHandler({ ...ENV, DISCORD_PUBLIC_KEY: publicKeyHex });
  const res = await handle(
    new Request("https://example.com/interactions", { method: "GET" }),
    () => {}
  );
  assert.equal(res.status, 405);
});

test("missing configuration fails loudly, naming the variable", () => {
  assert.throws(
    () => createHandler({ ...ENV, DISCORD_PUBLIC_KEY: undefined }),
    /DISCORD_PUBLIC_KEY/
  );
});
