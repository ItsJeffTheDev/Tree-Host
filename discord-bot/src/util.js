'use strict';
const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');
const { STAFF } = require('./config');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'state.json');

/** Reads KEY=value lines from .env into process.env (no extra package needed). */
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`Missing ${missing.join(', ')}. Copy .env.example to .env and fill it in (see README.md).`);
    process.exit(1);
  }
}

/** IDs of everything setup created (roles, channels, messages), so later runs update instead of duplicating. */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { roles: {}, channels: {}, messages: {}, automod: {}, youtube: { seen: [] } };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const bits = (names) => names.reduce((acc, n) => {
  if (PermissionFlagsBits[n] === undefined) throw new Error(`Unknown permission "${n}"`);
  return acc | PermissionFlagsBits[n];
}, 0n);

const READ = ['ViewChannel', 'ReadMessageHistory'];
const POST = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'AddReactions', 'AttachFiles', 'EmbedLinks'];
const VOICE = ['ViewChannel', 'Connect', 'Speak', 'Stream', 'UseVAD'];
const STAFF_EXTRA = ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'ManageMessages', 'ManageThreads', 'Connect', 'Speak'];

/**
 * Permission overwrites for an access preset (see config.js). roleId(key) gives a role ID; everyone = guild ID.
 * Staff can always see and moderate everything.
 */
function overwrites(access, everyone, roleId) {
  return presetOverwrites(access, everyone, roleId).filter(Boolean);
}

function presetOverwrites(access, everyone, roleId) {
  // A role that failed to create has no ID yet: leave it out rather than failing the whole channel.
  const ow = (id, allow = [], deny = []) => (id ? { id, allow: bits(allow), deny: bits(deny) } : null);
  const staff = STAFF.map((k) => ow(roleId(k), STAFF_EXTRA));
  const member = roleId('member');
  switch (access) {
    case 'info':
      return [ow(everyone, READ, ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads']), ...staff];
    case 'open':
      // Everyone, verified or not, can read and post. Discord's Onboarding needs at least one channel like this.
      return [ow(everyone, [...READ, ...POST]), ...staff];
    case 'members':
      return [ow(everyone, [], ['ViewChannel']), ow(member, [...READ, ...POST]), ...staff];
    case 'membersReadonly':
      return [ow(everyone, [], ['ViewChannel', 'SendMessages']), ow(member, READ, ['SendMessages', 'CreatePublicThreads']), ...staff];
    case 'membersForum':
      // Forums: "SendMessages" = create a post. Unverified people can read but not post.
      return [ow(everyone, READ, ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads']), ow(member, [...READ, ...POST]), ...staff];
    case 'voice':
      return [ow(everyone, [], ['ViewChannel']), ow(member, VOICE), ...staff];
    case 'afk':
      return [ow(everyone, [], ['ViewChannel']), ow(member, ['ViewChannel', 'Connect'], ['Speak', 'Stream']), ...staff];
    case 'staff':
      return [ow(everyone, [], ['ViewChannel']), ...staff];
    default:
      throw new Error(`Unknown access preset "${access}"`);
  }
}

module.exports = { ROOT, loadEnv, requireEnv, loadState, saveState, bits, overwrites };
