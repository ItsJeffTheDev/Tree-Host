'use strict';
// Role-based access control. Every staff action checks a permission (e.g. "billing.manage"), never a role name.
// Roles are lists of permissions, stored with the rest of the business data (Firebase Realtime Database + local
// copy, see store.js), so the Owner can change what each role may do from the Staff Console without a deploy.
const store = require('./store');

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/** Every permission, grouped for the Staff Console. Customers never need any: they act on their own servers. */
const PERMISSIONS = [
  { id: 'console.access', group: 'Staff Console', label: 'Open the Staff Console', description: 'See the /admin page and its overview.' },
  { id: 'servers.viewAll', group: 'Servers', label: "See every customer's server", description: 'The "All servers" list, any server\'s console output, files and settings.' },
  { id: 'servers.operate', group: 'Servers', label: 'Start, stop and run commands', description: "On anyone's server: start, stop, restart, kill and console commands." },
  { id: 'servers.edit', group: 'Servers', label: 'Change files, plugins and settings', description: "On anyone's server: files, plugins, game settings, backups, deploys." },
  { id: 'servers.destroy', group: 'Servers', label: 'Delete servers, reset worlds, change versions', description: "On anyone's server. These can't be undone." },
  { id: 'servers.host', group: 'Servers', label: 'Host-level settings', description: 'Custom Java paths, custom server jars, ports and other settings that touch the machine itself.' },
  { id: 'users.view', group: 'People', label: 'See accounts', description: 'The People list: names, emails, plans and server counts.' },
  { id: 'users.manage', group: 'People', label: 'Manage accounts', description: 'Suspend, send password resets, set temporary passwords, delete accounts.' },
  { id: 'users.roles', group: 'People', label: 'Change roles and invite staff', description: 'Only up to your own role: nobody can hand out more access than they have.' },
  { id: 'billing.view', group: 'Billing', label: 'See billing', description: 'Revenue, every subscription, capacity.' },
  { id: 'billing.manage', group: 'Billing', label: 'Manage billing', description: 'Cancel subscriptions, give free plans, edit plans and prices, set capacity.' },
  { id: 'moderation.view', group: 'Moderation', label: 'See actions taken', description: 'The Actions Taken page: every warning, suspension, ban and deletion, its evidence and PDF report.' },
  { id: 'moderation.act', group: 'Moderation', label: 'Warn and suspend', description: 'Warn or suspend accounts and servers (with a reason and evidence), add evidence, lift suspensions.' },
  { id: 'moderation.ban', group: 'Moderation', label: 'Ban', description: 'Ban accounts and servers, and lift bans.' },
  { id: 'moderation.appeals', group: 'Moderation', label: 'Decide appeals', description: 'Accept or deny appeals from customers.' },
  { id: 'messages.send', group: 'Moderation', label: 'Message customers', description: "Send a message to someone's Tree Host inbox (and email)." },
  { id: 'support.chat', group: 'Support', label: 'Answer support chats', description: 'Staff Console → Support chat: see and answer live chats from customers, claim and close them.' },
  { id: 'promos.manage', group: 'Billing', label: 'Manage promo codes', description: 'Create and disable codes for free plans (creators, partners, giveaways).' },
  { id: 'creators.manage', group: 'Billing', label: 'Manage creators', description: 'Create and disable creator codes, mark payouts, see creator earnings.' },
  { id: 'activity.viewAll', group: 'Platform', label: 'See all activity', description: 'Including sign-ups and payments, not just server events.' },
  { id: 'audit.view', group: 'Platform', label: 'See the audit log', description: 'Every staff action: who did what, when.' },
  { id: 'system.view', group: 'Platform', label: 'See system info', description: 'Memory, Java versions, data folder, full error details.' },
  { id: 'system.manage', group: 'Platform', label: 'Manage required plugins', description: 'Add, edit, delete, and distribute required plugins to all servers.' },
  { id: 'settings.manage', group: 'Platform', label: 'Change site settings', description: 'Open or close sign-ups, Discord notifications.' },
  { id: 'roles.manage', group: 'Platform', label: 'Edit roles', description: 'Change what each role can do (this page).' },
  // Perks for creators (the YouTuber role). They work on every Tree Host Paper/Spigot/Purpur/Folia server through the
  // Tree Host staff plugin, and only for people who aren't staff (staff wear the STAFF badge instead).
  { id: 'creator.badge', group: 'Creator perks', label: 'YouTuber badge in-game', description: 'A red ▶ YOUTUBER tag above their head, in chat and in the player list on every Tree Host server.' },
  { id: 'creator.announce', group: 'Creator perks', label: 'Join announcement', description: 'Everyone on the server is told when they join.' },
  { id: 'creator.joinFull', group: 'Creator perks', label: 'Join full servers', description: 'They can still join when a server is full.' },
  { id: 'creator.joinWhitelist', group: 'Creator perks', label: 'Skip whitelists', description: "They can join servers that have a whitelist on, even if they're not on it. Bans still apply." },
  { id: 'creator.featured', group: 'Creator perks', label: 'Featured on the server list', description: 'Their listed servers are shown first on the public Servers page, with a Featured badge.' },
];
/** Creator perks, and what the staff plugin calls them in creators.txt. */
const CREATOR_PERKS = { 'creator.badge': 'badge', 'creator.announce': 'announce', 'creator.joinFull': 'joinfull', 'creator.joinWhitelist': 'whitelist' };
const PERMISSION_IDS = new Set(PERMISSIONS.map((p) => p.id));
// The permissions that existed before roles remembered which ones they knew (for adding new ones on upgrade).
const FIRST_PERMISSIONS = ['console.access', 'servers.viewAll', 'servers.operate', 'servers.edit', 'servers.destroy', 'servers.host', 'users.view', 'users.manage',
  'users.roles', 'billing.view', 'billing.manage', 'promos.manage', 'creators.manage', 'activity.viewAll', 'audit.view', 'system.view', 'system.manage', 'settings.manage', 'roles.manage'];

/**
 * Roles from most to least access. `level` decides who may manage whom: you can only assign roles below your
 * own level (Owners can assign anything). Owner always has every permission; Customer never has any.
 */
// Admins run the business but don't touch the machine itself or what roles can do.
const ADMIN_EXCLUDED = ['roles.manage', 'servers.host', ...PERMISSIONS.filter((p) => p.group === 'Creator perks').map((p) => p.id)];
// Taken away from saved roles once (the Owner can give them back in Roles & permissions).
const REVOKED = { 2: { staff: ['servers.edit', 'servers.host'], developer: ['servers.edit', 'servers.host'], admin: ['servers.host'] } };

const DEFAULT_ROLES = [
  { id: 'owner', label: 'Owner', level: 100, locked: true, description: 'Runs Tree Host. Every permission, always.' },
  {
    id: 'admin', label: 'Admin', level: 80, description: 'Runs day-to-day business: people, billing, servers. No machine-level settings or role editing.',
    permissions: PERMISSIONS.map((p) => p.id).filter((id) => !ADMIN_EXCLUDED.includes(id)),
  },
  {
    id: 'developer', label: 'Developer', level: 60, description: "Builds and fixes Tree Host: sees every server and its console, system info. Can't open customers' files or settings.",
    permissions: ['console.access', 'servers.viewAll', 'servers.operate', 'users.view', 'audit.view', 'system.view', 'system.manage', 'moderation.view'],
  },
  {
    id: 'staff', label: 'Support', level: 40, description: "Helps customers: sees any server and its console, starts and stops it, sees accounts and plans. Can't open customers' files or settings, or delete anything.",
    permissions: ['console.access', 'servers.viewAll', 'servers.operate', 'users.view', 'billing.view', 'moderation.view', 'moderation.act', 'messages.send', 'support.chat'],
  },
  {
    id: 'youtuber', label: 'YouTuber', level: 10, customer: true,
    description: 'Content creators. A customer account with creator perks: a YouTuber badge on their profile, on their listed servers and above their head in-game. No staff powers unless you add some here.',
    permissions: ['creator.badge', 'creator.announce', 'creator.joinFull', 'creator.featured'],
  },
  { id: 'customer', label: 'Customer', level: 0, locked: true, customer: true, description: 'Everyone who signs up. Manages only their own servers.' },
];
/** Roles that are customers (their own servers and plans) rather than staff, whatever badge they wear. */
const CUSTOMER_ROLES = DEFAULT_ROLES.filter((r) => r.customer).map((r) => r.id);

class Rbac {
  constructor() {
    this.roles = DEFAULT_ROLES.map((r) => ({ ...r, permissions: r.permissions ? [...r.permissions] : [] }));
  }

  /** Loads role permissions saved from the Staff Console (Firebase), on top of the defaults. */
  async init() {
    const saved = (await store.load('roles')) || {};
    // Permissions added after the roles were saved get their default setting (saved roles list what they knew).
    const known = new Set(saved._known ? Object.values(saved._known) : FIRST_PERMISSIONS);
    let added = false;
    for (const r of this.roles) {
      const s = saved[r.id];
      if (!s || r.locked || !s.permissions) continue;
      const def = DEFAULT_ROLES.find((d) => d.id === r.id).permissions || [];
      const fresh = def.filter((p) => !known.has(p));
      r.permissions = [...new Set([...Object.values(s.permissions).filter((p) => PERMISSION_IDS.has(p)), ...fresh])];
      if (fresh.length) added = true;
    }
    // Tightened defaults (e.g. Support and Developer no longer open customers' files and settings).
    let rev = Number(saved._rev) || 1;
    if (Object.keys(saved).length) {
      for (const [n, byRole] of Object.entries(REVOKED)) {
        if (rev >= Number(n)) continue;
        for (const r of this.roles) if (byRole[r.id]) r.permissions = r.permissions.filter((p) => !byRole[r.id].includes(p));
        added = true;
      }
    }
    if (added || (Object.keys(saved).length && !saved._known)) await this.save();
  }

  save() {
    const out = { _known: [...PERMISSION_IDS], _rev: Math.max(...Object.keys(REVOKED).map(Number)) };
    for (const r of this.roles) if (!r.locked) out[r.id] = { permissions: r.permissions };
    return store.save('roles', out);
  }

  role(id) {
    return this.roles.find((r) => r.id === id) || this.roles.find((r) => r.id === 'customer');
  }

  level(roleId) {
    return this.role(roleId).level;
  }

  isRole(id) {
    return this.roles.some((r) => r.id === id);
  }

  /** Everything this user may do (Owner: all). */
  permissionsOf(user) {
    if (!user || user.restriction) return [];
    if (user.role === 'owner') return [...PERMISSION_IDS];
    return [...this.role(user.role).permissions];
  }

  can(user, permission) {
    if (!PERMISSION_IDS.has(permission)) throw new Error(`Unknown permission "${permission}"`);
    if (!user || user.disabled || user.restriction) return false; // suspended or banned staff lose their powers
    if (user.role === 'owner') return true;
    return this.role(user.role).permissions.includes(permission);
  }

  /** A customer account (Customer or YouTuber), not staff. */
  isCustomer(user) {
    return !!user && CUSTOMER_ROLES.includes(user.role);
  }

  /** Staff = anyone who can open the Staff Console. */
  isStaff(user) {
    return this.can(user, 'console.access');
  }

  /** Who may give `target` the role `newRole`: you need users.roles, and both roles must be below yours. */
  checkRoleChange(actor, target, newRole) {
    if (!this.isRole(newRole)) throw httpError(400, 'Unknown role.');
    if (actor.role === 'owner') return;
    if (!this.can(actor, 'users.roles')) throw httpError(403, "You can't change roles.");
    const mine = this.level(actor.role);
    if (target && this.level(target.role) >= mine) throw httpError(403, `Only someone above ${this.role(target.role).label} can change this person's role.`);
    if (this.level(newRole) >= mine) throw httpError(403, `You can only give roles below your own (${this.role(actor.role).label}).`);
  }

  /** Changes what a role can do (Owner/Customer are fixed). */
  async setPermissions(roleId, permissions) {
    const r = this.roles.find((x) => x.id === roleId);
    if (!r) throw httpError(404, 'Unknown role.');
    if (r.locked) throw httpError(400, `${r.label} can't be changed: it always has ${r.id === 'owner' ? 'every' : 'no'} permission.`);
    const list = [...new Set((permissions || []).filter((p) => PERMISSION_IDS.has(p)))];
    r.permissions = list;
    await this.save();
    return this.publicRoles();
  }

  async resetDefaults() {
    this.roles = DEFAULT_ROLES.map((r) => ({ ...r, permissions: r.permissions ? [...r.permissions] : [] }));
    await this.save();
    return this.publicRoles();
  }

  publicRoles() {
    return {
      permissions: PERMISSIONS,
      roles: this.roles.map((r) => ({
        id: r.id, label: r.label, level: r.level, locked: !!r.locked, customer: !!r.customer, description: r.description,
        permissions: r.id === 'owner' ? [...PERMISSION_IDS] : r.permissions,
      })),
    };
  }
}

module.exports = { Rbac, PERMISSIONS, DEFAULT_ROLES, CUSTOMER_ROLES, CREATOR_PERKS };
