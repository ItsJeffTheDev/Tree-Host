'use strict';
// Passkeys (WebAuthn) as an honest stub. The routes below exist so the UI can offer "passkeys" without
// lying about it: the pieces that are easy and safe with Node's crypto alone are real — random challenge
// generation, storage and single-use expiry — and the parts that need a real WebAuthn implementation
// (credential registration and signature verification, attestation parsing) are not built yet and answer
// 501 with a clear message instead of pretending. No packages allowed in this repo, so building full
// WebAuthn from scratch here would mean hand-rolled CBOR/COSE parsing — not something to rush into
// an auth path. When it's built for real: register the credential here, verify signatures with the
// stored public key, and drop the stub routes.

const crypto = require('crypto');

const CHALLENGE_TTL = 5 * 60000;
const MAX_PENDING = 500;

function randomChallenge() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * A challenge for a future registration or sign-in: random, single-use, 5-minute expiry, capped so a
 * runaway client can't grow the map without bound. Real WebAuthn binds the challenge to the session and
 * checks it inside the attestation/assertion — this map is where those challenges live until then.
 */
function newChallenge(map, kind) {
  const challenge = randomChallenge();
  map.set(challenge, { kind, expires: Date.now() + CHALLENGE_TTL });
  if (map.size > MAX_PENDING) {
    const now = Date.now();
    for (const [c, e] of map) if (e.expires < now) map.delete(c);
  }
  return challenge;
}

/** True only for a live challenge of the right kind (and burns it: a challenge never works twice). */
function useChallenge(map, challenge, kind) {
  const e = map.get(String(challenge || ''));
  map.delete(String(challenge || ''));
  return !!e && e.kind === kind && e.expires > Date.now();
}

module.exports = { newChallenge, useChallenge, randomChallenge, CHALLENGE_TTL };
