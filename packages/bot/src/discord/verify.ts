/**
 * Ed25519 request verification.
 *
 * Discord signs every interaction POST and will not accept an endpoint that
 * fails to reject a forged one — it actively probes with bad signatures during
 * endpoint validation. This is also the only thing standing between the
 * internet and the task table, since the URL is public by necessity.
 *
 * Written against WebCrypto rather than node:crypto so the same code runs on a
 * worker runtime and under Node 22.
 */

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("public key hex has an odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("public key is not valid hex");
    out[i] = byte;
  }
  return out;
}

/**
 * Workers historically exposed Ed25519 as "NODE-ED25519"; the standard name is
 * "Ed25519" and Node 22 uses that. Try the standard name first and fall back,
 * so this does not silently fail to import a key on one runtime.
 */
async function importKey(publicKeyHex: string): Promise<CryptoKey> {
  const raw = hexToBytes(publicKeyHex);
  const attempts: Array<AlgorithmIdentifier | { name: string; namedCurve: string }> = [
    { name: "Ed25519" },
    { name: "NODE-ED25519", namedCurve: "NODE-ED25519" },
  ];
  let lastError: unknown;
  for (const algorithm of attempts) {
    try {
      return await crypto.subtle.importKey(
        "raw",
        raw as BufferSource,
        algorithm as AlgorithmIdentifier,
        false,
        ["verify"]
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `This runtime does not support Ed25519 in WebCrypto: ${String(lastError)}`
  );
}

/**
 * True when `signature` is a valid Ed25519 signature over `timestamp + body`.
 *
 * `body` must be the exact raw request text. Parsing and re-serialising the
 * JSON first changes the bytes and every signature fails — a classic and
 * confusing way to break this.
 */
export async function verifyRequest(args: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  body: string;
}): Promise<boolean> {
  const { publicKeyHex, signatureHex, timestamp, body } = args;
  if (!signatureHex || !timestamp) return false;

  let signature: Uint8Array;
  try {
    signature = hexToBytes(signatureHex);
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;

  try {
    const key = await importKey(publicKeyHex);
    const message = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      signature as BufferSource,
      message as BufferSource
    );
  } catch {
    // A verification that throws is a verification that failed.
    return false;
  }
}
