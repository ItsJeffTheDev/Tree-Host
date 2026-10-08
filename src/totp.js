'use strict';
// Two-factor sign-in codes (TOTP, RFC 6238): the 6-digit codes from Google Authenticator, Authy, 1Password and the
// like. Node's crypto only, no packages.

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30; // seconds per code
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret (160 bits, the usual size), as base32 for the authenticator app. */
const newSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Checks a code, allowing one step either side for a phone clock that's slightly off. Returns the step it matched
 * (so the caller can refuse the same code twice) or null.
 */
function verify(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 1000 / STEP);
  for (const s of [step, step - 1, step + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

/** The otpauth:// link authenticator apps understand (tap it on a phone, or type the secret in by hand). */
const uri = (secret, account, issuer = 'Tree Host') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;

module.exports = { newSecret, verify, uri, codeAt, base32Encode, base32Decode };
