'use strict';
// Firebase without npm packages:
//  - verifies Firebase Auth ID tokens (RS256 JWTs signed by Google) so the browser's sign-in can be trusted;
//  - talks to the Realtime Database and the Auth admin API with a service account (OAuth access token).
// The web config (FIREBASE_API_KEY etc.) is public by design; the service account key is a secret.
const fs = require('fs');
const crypto = require('crypto');

const web = {
  apiKey: process.env.FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
  databaseURL: (process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, ''),
  projectId: process.env.FIREBASE_PROJECT_ID || '',
  appId: process.env.FIREBASE_APP_ID || '',
};
// Where Tree Host keeps its data inside the database.
const ROOT = (process.env.FIREBASE_DB_ROOT || 'treehost').replace(/^\/|\/$/g, '');

let serviceAccount = null;
try {
  const file = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  if (file) serviceAccount = JSON.parse(fs.readFileSync(file, 'utf8'));
  else if (process.env.FIREBASE_SERVICE_ACCOUNT) serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error(`  Could not read the Firebase service account: ${e.message}`);
}

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Sign-in with Firebase is on when the web config is set. */
const authEnabled = () => !!(web.apiKey && web.projectId);
/** The Realtime Database is used when it has a URL and a service account to write with. */
const dbEnabled = () => !!(web.databaseURL && serviceAccount && serviceAccount.private_key);

function publicConfig() {
  return authEnabled() ? { apiKey: web.apiKey, authDomain: web.authDomain, projectId: web.projectId, appId: web.appId } : null;
}

// ---------- ID token verification ----------

let certs = { keys: {}, expires: 0 };

async function googleCerts() {
  if (Date.now() < certs.expires) return certs.keys;
  const res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com', {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw httpError(503, 'Could not reach Google to check the sign-in. Try again.');
  const maxAge = Number((/max-age=(\d+)/.exec(res.headers.get('cache-control') || '') || [])[1]) || 3600;
  certs = { keys: await res.json(), expires: Date.now() + maxAge * 1000 };
  return certs.keys;
}

/** Checks a Firebase ID token and returns its claims (uid, email, email_verified, provider). */
async function verifyIdToken(token) {
  if (!authEnabled()) throw httpError(400, 'Sign-in is not set up yet.');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw httpError(401, 'Invalid sign-in. Please sign in again.', 'AUTH');
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw httpError(401, 'Invalid sign-in. Please sign in again.', 'AUTH');
  }
  if (header.alg !== 'RS256' || !header.kid) throw httpError(401, 'Invalid sign-in. Please sign in again.', 'AUTH');
  let pem = (await googleCerts())[header.kid];
  if (!pem) {
    certs.expires = 0; // keys rotated: fetch them again once
    pem = (await googleCerts())[header.kid];
  }
  if (!pem) throw httpError(401, 'Invalid sign-in. Please sign in again.', 'AUTH');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey(pem), Buffer.from(parts[2], 'base64url'));
  const now = Math.floor(Date.now() / 1000);
  if (
    !ok ||
    claims.aud !== web.projectId ||
    claims.iss !== `https://securetoken.google.com/${web.projectId}` ||
    !claims.sub ||
    typeof claims.sub !== 'string' ||
    !(claims.exp > now) ||
    !(claims.iat <= now + 300) ||
    !(claims.auth_time <= now + 300)
  ) {
    throw httpError(401, 'Your sign-in expired. Please sign in again.', 'AUTH');
  }
  return {
    uid: claims.sub,
    email: claims.email ? String(claims.email).toLowerCase() : '',
    emailVerified: !!claims.email_verified,
    provider: (claims.firebase && claims.firebase.sign_in_provider) || '',
    name: claims.name || '',
  };
}

// ---------- service account (admin access) ----------

let access = { token: null, expires: 0 };

async function accessToken() {
  if (!serviceAccount) throw httpError(500, 'The Firebase service account is not set up.');
  if (access.token && Date.now() < access.expires) return access.token;
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/identitytoolkit',
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), serviceAccount.private_key);
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${body}.${b64url(sig)}`,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw httpError(502, `Firebase login for the server failed: ${json.error_description || json.error || res.status}`);
  access = { token: json.access_token, expires: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 60000 };
  return access.token;
}

// ---------- Realtime Database (REST) ----------

async function db(method, pathname, value) {
  const url = `${web.databaseURL}/${ROOT}/${pathname}.json`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw httpError(502, `Realtime Database ${method} ${pathname} failed (${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const dbGet = (p) => db('GET', p);
const dbSet = (p, v) => db('PUT', p, v);

// ---------- Auth admin ----------

/** Deletes a Firebase Auth account (when an admin deletes a Tree Host account). */
async function deleteAuthUser(uid) {
  if (!serviceAccount || !uid) return false;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${web.projectId}/accounts:delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ localId: uid }),
    signal: AbortSignal.timeout(15000),
  });
  return res.ok;
}

module.exports = { authEnabled, dbEnabled, publicConfig, verifyIdToken, dbGet, dbSet, deleteAuthUser, ROOT };
