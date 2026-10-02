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
  { id: 'promos.manage', group: 'Billing', label: 'Manage promo codes', description: 'Create and disable codes for free plans (creators, partners, giveaways).' },
  { id: 'activity.viewAll', group: 'Platform', label: 'See all activity', description: 'Including sign-ups and payments, not just server events.' },
  { id: 'audit.view', group: 'Platform', label: 'See the audit log', description: 'Every staff action: who did what, when.' },
  { id: 'system.view', group: 'Platform', label: 'See system info', description: 'Memory, Java versions, data folder, full error details.' },
  { id: 'settings.manage', group: 'Platform', label: 'Change site settings', description: 'Open or close sign-ups, Discord notifications.' },
  { id: 'roles.manage', group: 'Platform', label: 'Edit roles', description: 'Change what each role can do (this page).' },
];
const PERMISSION_IDS = new Set(PERMISSIONS.map((p) => p.id));

/**
 * Roles from most to least access. `level` decides who may manage whom: you can only assign roles below your
 * own level (Owners can assign anything). Owner always has every permission; Customer never has any.
 */
const DEFAULT_ROLES = [
  { id: 'owner', label: 'Owner', level: 100, locked: true, description: 'Runs Tree Host. Every permission, always.' },
  {
    id: 'admin', label: 'Admin', level: 80, description: 'Runs day-to-day business: people, billing, servers.',
    permissions: PERMISSIONS.map((p) => p.id).filter((id) => id !== 'roles.manage'),
  },
  {
    id: 'developer', label: 'Developer', level: 60, description: 'Builds and fixes Tree Host: servers, host settings, system info. No money or people management.',
    permissions: ['console.access', 'servers.viewAll', 'servers.operate', 'servers.edit', 'servers.destroy', 'servers.host', 'users.view', 'audit.view', 'system.view'],
  },
  {
    id: 'staff', label: 'Support', level: 40, description: "Helps customers: sees and fixes any server, sees accounts and plans, can't delete anything.",
    permissions: ['console.access', 'servers.viewAll', 'servers.operate', 'servers.edit', 'users.view', 'billing.view'],
  },
  { id: 'customer', label: 'Customer', level: 0, locked: true, description: 'Everyone who signs up. Manages only their own servers.' },
];

class Rbac {
  constructor() {
    this.roles = DEFAULT_ROLES.map((r) => ({ ...r, permissions: r.permissions ? [...r.permissions] : [] }));
  }

  /** Loads role permissions saved from the Staff Console (Firebase), on top of the defaults. */
  async init() {
    const saved = (await store.load('roles')) || {};
    for (const r of this.roles) {
      const s = saved[r.id];
      if (s && !r.locked && s.permissions) r.permissions = Object.values(s.permissions).filter((p) => PERMISSION_IDS.has(p));
    }
  }

  save() {
    const out = {};
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
    if (!user) return [];
    if (user.role === 'owner') return [...PERMISSION_IDS];
    return [...this.role(user.role).permissions];
  }

  can(user, permission) {
    if (!PERMISSION_IDS.has(permission)) throw new Error(`Unknown permission "${permission}"`);
    if (!user || user.disabled) return false;
    if (user.role === 'owner') return true;
    return this.role(user.role).permissions.includes(permission);
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
        id: r.id, label: r.label, level: r.level, locked: !!r.locked, description: r.description,
        permissions: r.id === 'owner' ? [...PERMISSION_IDS] : r.permissions,
      })),
    };
  }
}

module.exports = { Rbac, PERMISSIONS, DEFAULT_ROLES };
