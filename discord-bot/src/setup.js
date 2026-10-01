'use strict';
// Builds the Tree Host Discord server from config.js. Safe to run again: it updates what exists.
//   npm run setup     apply to the server in DISCORD_GUILD_ID
//   npm run check     validate config, embeds and permissions offline (no token needed)
const path = require('path');
const {
  Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, GuildFeature,
  GuildVerificationLevel, GuildExplicitContentFilter, GuildDefaultMessageNotifications, GuildSystemChannelFlags,
  AutoModerationRuleEventType, AutoModerationRuleTriggerType, AutoModerationRuleKeywordPresetType, AutoModerationActionType,
} = require('discord.js');
const cfg = require('./config');
const buildEmbeds = require('./embeds');
const { ROOT, loadEnv, requireEnv, loadState, saveState, bits, overwrites } = require('./util');

const TYPES = {
  text: ChannelType.GuildText, announcement: ChannelType.GuildAnnouncement,
  voice: ChannelType.GuildVoice, forum: ChannelType.GuildForum,
};
const warnings = [];
const warn = (msg) => { warnings.push(msg); console.log(`  ! ${msg}`); };
const allChannels = () => cfg.CATEGORIES.flatMap((c) => c.channels.map((ch) => ({ ...ch, category: c })));

// ---------- offline check ----------
function check() {
  const fakeGuild = { id: '1', iconURL: () => null };
  const embeds = buildEmbeds(fakeGuild, (k) => `<#${k}>`, (k) => `<@&${k}>`);
  for (const [key, p] of Object.entries(embeds)) {
    p.embeds.forEach((e) => e.toJSON());
    (p.components || []).forEach((r) => r.toJSON());
    const len = p.embeds.reduce((n, e) => n + JSON.stringify(e.toJSON()).length, 0);
    if (!allChannels().some((c) => c.embed === key)) throw new Error(`Embed "${key}" is not used by any channel`);
    console.log(`  embed ${key.padEnd(12)} ok (${len} chars)`);
  }
  for (const ch of allChannels()) {
    if (ch.embed && !embeds[ch.embed]) throw new Error(`Channel ${ch.key} uses missing embed ${ch.embed}`);
    if (ch.name.length > 100) throw new Error(`Channel name too long: ${ch.name}`);
    if ((ch.topic || '').length > 1024) throw new Error(`Topic too long: ${ch.key}`);
    overwrites(ch.access || ch.category.access, '0', (k) => k);
  }
  cfg.ROLES.forEach((r) => bits(r.permissions));
  bits(cfg.EVERYONE_PERMISSIONS);
  const count = (t) => cfg.AUTOMOD.filter((r) => r.trigger === t).length;
  if (count('Keyword') > 6 || count('Spam') > 1 || count('MentionSpam') > 1 || count('KeywordPreset') > 1) throw new Error('Too many AutoMod rules of one type');
  for (const r of cfg.AUTOMOD) for (const re of r.regex || []) {
    new RegExp(re);
    if (re.length > 260) throw new Error(`AutoMod regex too long: ${re}`);
  }
  const keys = new Set();
  for (const k of [...cfg.ROLES.map((r) => r.key), ...cfg.CATEGORIES.map((c) => c.key), ...allChannels().map((c) => c.key)]) {
    if (keys.has(k)) throw new Error(`Duplicate key "${k}"`);
    keys.add(k);
  }
  console.log(`  ${cfg.ROLES.length} roles, ${cfg.CATEGORIES.length} categories, ${allChannels().length} channels, ${cfg.AUTOMOD.length} AutoMod rules: config OK`);
}

// ---------- apply ----------
async function main() {
  loadEnv();
  if (process.argv.includes('--check')) return check();
  requireEnv('DISCORD_TOKEN', 'DISCORD_GUILD_ID');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const ready = new Promise((r) => client.once('clientReady', r));
  await client.login(process.env.DISCORD_TOKEN);
  await ready;
  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID).catch(() => null);
  if (!guild) {
    console.error('The bot is not in that server. Invite it first: npm run invite');
    process.exit(1);
  }
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.Administrator)) {
    console.error('The bot needs the Administrator permission to build the server. Re-invite it with: npm run invite');
    process.exit(1);
  }
  console.log(`Setting up "${guild.name}" as ${client.user.tag}...`);
  const state = loadState();
  const roleId = (k) => state.roles[k];
  const chId = (k) => state.channels[k];

  // ----- the bot's own profile (About Me + tags) -----
  try {
    await client.application.edit({ description: cfg.BOT_PROFILE.description, tags: cfg.BOT_PROFILE.tags });
    console.log('Bot profile: About Me and tags set');
  } catch (e) { warn(`Bot profile: ${e.message}`); }

  // ----- server name + icon -----
  console.log('Server');
  try {
    await guild.edit({ name: cfg.SERVER.name, icon: path.resolve(ROOT, cfg.SERVER.icon) });
  } catch (e) { warn(`Could not set name/icon: ${e.message}`); }

  // ----- roles -----
  console.log('Roles');
  await guild.roles.fetch();
  await guild.roles.everyone.setPermissions(bits(cfg.EVERYONE_PERMISSIONS)).catch((e) => warn(`@everyone permissions: ${e.message}`));
  for (const r of cfg.ROLES) {
    const data = { name: r.name, colors: { primaryColor: r.color }, hoist: r.hoist, permissions: bits(r.permissions), mentionable: false };
    let role = guild.roles.cache.get(state.roles[r.key]) || guild.roles.cache.find((x) => x.name === r.name && !x.managed);
    try {
      if (role) {
        if (role.position < me.roles.highest.position) await role.edit(data);
        else warn(`"${r.name}" is above the bot's role, so it was left as is. Drag the bot's role to the top in Server Settings → Roles.`);
      } else {
        role = await guild.roles.create({ ...data, reason: 'Tree Host setup' });
      }
      state.roles[r.key] = role.id;
      console.log(`  ${role.name}`);
    } catch (e) { warn(`Role ${r.name}: ${e.message}`); }
  }
  // Order: config order, directly below the bot's own role. Roles are moved one at a time (a bulk reorder fails
  // when other bots' managed roles sit in between).
  try {
    let above = (await guild.members.fetchMe()).roles.highest.id;
    for (const r of cfg.ROLES) {
      const id = state.roles[r.key];
      if (!id) continue;
      await guild.roles.fetch();
      const role = guild.roles.cache.get(id);
      const target = guild.roles.cache.get(above).position - 1;
      if (role && role.position !== target && role.position < (await guild.members.fetchMe()).roles.highest.position) {
        await role.setPosition(Math.max(1, target));
      }
      above = id;
    }
  } catch (e) { warn(`Role order: ${e.message}`); }
  // ----- Bots role: give it to every bot in the server -----
  const botsRole = cfg.ROLES.find((r) => r.bots);
  if (botsRole && roleId(botsRole.key)) {
    let bots;
    try {
      // Listing members needs "Server Members Intent" on in the Developer Portal (Bot page).
      bots = [...(await guild.members.list({ limit: 1000 })).values()].filter((m) => m.user.bot);
    } catch {
      bots = (await Promise.all([client.user.id, cfg.DISBOARD_BOT_ID].map((id) => guild.members.fetch(id).catch(() => null)))).filter(Boolean);
      console.log('  (Turn on "Server Members Intent" in the Developer Portal → Bot so setup can find every bot.)');
    }
    for (const m of bots) {
      if (m.roles.cache.has(roleId(botsRole.key))) continue;
      await m.roles.add(roleId(botsRole.key), 'Bots role').then(() => console.log(`  Bots role → ${m.user.tag}`))
        .catch((e) => warn(`Bots role for ${m.user.tag}: ${e.message}`));
    }
  }
  saveState(state);

  // ----- categories + channels -----
  console.log('Channels');
  await guild.channels.fetch();
  const deferred = []; // announcement + forum channels need Community to be on first
  const findChannel = (key, name, types, parentId) =>
    guild.channels.cache.get(state.channels[key]) ||
    guild.channels.cache.find((c) => c.name === name && types.includes(c.type) && (parentId === undefined || c.parentId === parentId));

  for (const [ci, cat] of cfg.CATEGORIES.entries()) {
    const ow = overwrites(cat.access, guild.id, roleId);
    let category = findChannel(cat.key, cat.name, [ChannelType.GuildCategory]);
    try {
      if (category) await category.edit({ name: cat.name, permissionOverwrites: ow, position: ci });
      else category = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory, permissionOverwrites: ow, position: ci });
      state.channels[cat.key] = category.id;
      console.log(`  ${cat.name}`);
    } catch (e) { warn(`Category ${cat.name}: ${e.message}`); continue; }

    for (const [i, ch] of cat.channels.entries()) {
      const type = ch.type || 'text';
      if (type === 'forum' || type === 'announcement') { deferred.push({ ch, cat, category, i }); continue; }
      await applyChannel(ch, cat, category, i, TYPES[type]);
    }
  }

  async function applyChannel(ch, cat, category, position, type) {
    const data = {
      name: ch.name, type, parent: category.id, position,
      permissionOverwrites: overwrites(ch.access || cat.access, guild.id, roleId),
    };
    if (type !== ChannelType.GuildVoice) data.topic = ch.topic || null;
    // Slowmode exists for text and forum channels only (announcement channels reject it).
    if (type === ChannelType.GuildText || type === ChannelType.GuildForum) data.rateLimitPerUser = ch.slowmode || 0;
    if (type === ChannelType.GuildVoice) data.userLimit = ch.userLimit || 0;
    if (type === ChannelType.GuildForum) {
      data.availableTags = (ch.tags || []).map((t) => ({ name: t.name, moderated: !!t.moderated, emoji: { id: null, name: t.emoji } }));
      data.defaultReactionEmoji = { id: null, name: '👍' };
    }
    const sameKind = type === ChannelType.GuildVoice ? [type] : [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];
    let c = findChannel(ch.key, ch.name, sameKind, category.id);
    try {
      if (c && c.type !== type && type === ChannelType.GuildForum) {
        warn(`#${ch.name} exists as a normal channel; Discord can't turn it into a forum. Delete it and run setup again to get the forum.`);
        type = c.type;
        delete data.availableTags; delete data.defaultReactionEmoji;
        data.type = c.type;
      }
      if (c) {
        if (c.type !== data.type) await c.edit({ type: data.type });
        const { type: _t, ...edit } = data;
        await c.edit(edit);
      } else {
        c = await guild.channels.create(data);
      }
      state.channels[ch.key] = c.id;
      console.log(`    ${ch.name}`);
    } catch (e) { warn(`Channel ${ch.name}: ${e.message}`); }
  }
  saveState(state);

  // ----- server settings + Community -----
  console.log('Settings');
  try {
    await guild.edit({
      verificationLevel: GuildVerificationLevel[cfg.SERVER.verificationLevel],
      explicitContentFilter: GuildExplicitContentFilter[cfg.SERVER.explicitContentFilter],
      defaultMessageNotifications: GuildDefaultMessageNotifications[cfg.SERVER.defaultMessageNotifications],
      afkChannel: chId(cfg.SERVER.afkChannel) || null,
      afkTimeout: cfg.SERVER.afkTimeout,
      systemChannel: chId(cfg.SERVER.systemChannel) || null,
      systemChannelFlags: GuildSystemChannelFlags.SuppressGuildReminderNotifications,
    });
    console.log('  verification, content filter, notifications, AFK, system channel');
  } catch (e) { warn(`Server settings: ${e.message}`); }

  let community = guild.features.includes(GuildFeature.Community);
  if (!community) {
    try {
      await guild.edit({
        features: [...guild.features, GuildFeature.Community],
        rulesChannel: chId(cfg.SERVER.community.rulesChannel),
        publicUpdatesChannel: chId(cfg.SERVER.community.publicUpdatesChannel),
      });
      community = true;
      console.log('  Community turned on');
    } catch (e) { warn(`Could not turn on Community (announcement + forum channels will be normal channels): ${e.message}`); }
  } else {
    await guild.edit({
      rulesChannel: chId(cfg.SERVER.community.rulesChannel),
      publicUpdatesChannel: chId(cfg.SERVER.community.publicUpdatesChannel),
    }).catch((e) => warn(`Community channels: ${e.message}`));
    console.log('  Community already on');
  }
  // Discord accepts but ignores this change from bots on some servers, so check and explain the manual step.
  const fresh = await client.guilds.fetch({ guild: guild.id, force: true });
  if (fresh.rulesChannelId !== chId(cfg.SERVER.community.rulesChannel) ||
      fresh.publicUpdatesChannelId !== chId(cfg.SERVER.community.publicUpdatesChannel)) {
    warn('Discord did not let the bot change the Community channels. In Discord: Server Settings → Community → Overview → ' +
      'set "Rules or Guidelines Channel" to 📜・rules and "Community Updates Channel" to 💼・staff-chat.');
  }
  for (const { ch, cat, category, i } of deferred) {
    const type = community ? TYPES[ch.type] : ChannelType.GuildText;
    await applyChannel(ch, cat, category, i, type);
  }
  saveState(state);

  // ----- embeds -----
  console.log('Embeds');
  const embeds = buildEmbeds(guild, (k) => (chId(k) ? `<#${chId(k)}>` : `#${k}`), (k) => (roleId(k) ? `<@&${roleId(k)}>` : k),
    { goal: state.goal, status: state.status });
  for (const ch of allChannels().filter((c) => c.embed)) {
    const channel = guild.channels.cache.get(chId(ch.key)) || (await guild.channels.fetch(chId(ch.key)).catch(() => null));
    if (!channel || !channel.isTextBased()) { warn(`No channel for embed ${ch.embed}`); continue; }
    const payload = embeds[ch.embed];
    try {
      const old = state.messages[ch.embed] && (await channel.messages.fetch(state.messages[ch.embed]).catch(() => null));
      if (old) await old.edit({ ...payload, components: payload.components || [] });
      else state.messages[ch.embed] = (await channel.send(payload)).id;
      console.log(`  ${ch.embed} in ${channel.name}`);
    } catch (e) { warn(`Embed ${ch.embed}: ${e.message}`); }
  }
  saveState(state);

  // ----- permanent invite + DISBOARD -----
  console.log('Invite & DISBOARD');
  try {
    const invites = await guild.invites.fetch();
    let invite = state.invite && invites.get(state.invite);
    if (!invite) {
      const welcome = await guild.channels.fetch(chId('welcome'));
      invite = await welcome.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: 'Permanent invite for listings (DISBOARD etc.)' });
      state.invite = invite.code;
    }
    console.log(`  Permanent invite: https://discord.gg/${invite.code}`);
  } catch (e) { warn(`Invite: ${e.message}`); }
  const disboard = await guild.members.fetch(cfg.DISBOARD_BOT_ID).catch(() => null);
  const bumpChannel = chId('bump') && (await guild.channels.fetch(chId('bump')).catch(() => null));
  if (disboard && bumpChannel) {
    await bumpChannel.permissionOverwrites.edit(disboard.id, { ViewChannel: true, SendMessages: true, EmbedLinks: true, ReadMessageHistory: true })
      .then(() => console.log('  DISBOARD can use #bump'))
      .catch((e) => warn(`DISBOARD access to #bump: ${e.message}`));
  } else if (!disboard) {
    console.log('  DISBOARD is not in the server yet: add it from disboard.org, then run setup again.');
  }
  saveState(state);

  // ----- AutoMod -----
  console.log('AutoMod');
  const existing = await guild.autoModerationRules.fetch().catch((e) => { warn(`AutoMod: ${e.message}`); return null; });
  if (existing) {
    const exemptRoles = cfg.STAFF.map(roleId).filter(Boolean);
    const exemptChannels = ['staffChat', 'modLog', 'ticketLog'].map(chId).filter(Boolean);
    for (const r of cfg.AUTOMOD) {
      const triggerType = AutoModerationRuleTriggerType[r.trigger];
      const actions = [];
      if (r.block) actions.push({ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: r.block.slice(0, 150) } });
      if (r.alert && chId('modLog')) actions.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: chId('modLog') } });
      if (r.timeoutSeconds) actions.push({ type: AutoModerationActionType.Timeout, metadata: { durationSeconds: r.timeoutSeconds } });
      const triggerMetadata = {};
      if (r.keywords) triggerMetadata.keywordFilter = r.keywords;
      if (r.regex) triggerMetadata.regexPatterns = r.regex;
      if (r.presets) triggerMetadata.presets = r.presets.map((p) => AutoModerationRuleKeywordPresetType[p]);
      if (r.trigger === 'MentionSpam') Object.assign(triggerMetadata, { mentionTotalLimit: r.mentionLimit, mentionRaidProtectionEnabled: !!r.raidProtection });
      const data = {
        name: r.name, eventType: AutoModerationRuleEventType.MessageSend, triggerType, actions, enabled: true,
        exemptRoles, exemptChannels, ...(Object.keys(triggerMetadata).length ? { triggerMetadata } : {}),
      };
      // Spam, mention spam and preset rules can only exist once per server, so reuse any existing one.
      const unique = ['Spam', 'MentionSpam', 'KeywordPreset'].includes(r.trigger);
      const found = existing.get(state.automod[r.name]) || existing.find((x) => x.name === r.name) ||
        (unique ? existing.find((x) => x.triggerType === triggerType) : null);
      try {
        const { triggerType: _t, ...edit } = data;
        const rule = found ? await found.edit(edit) : await guild.autoModerationRules.create(data);
        state.automod[r.name] = rule.id;
        console.log(`  ${r.name}`);
      } catch (e) {
        // Discord's own built-in rules (e.g. "Block Mention Spam") can't be edited by apps; keep them as they are.
        if (found && found.creatorId !== client.user.id) console.log(`  ${r.name}: kept Discord's built-in "${found.name}" rule`);
        else warn(`AutoMod "${r.name}": ${e.message}`);
      }
    }
  }
  saveState(state);

  console.log('');
  console.log(warnings.length ? `Done with ${warnings.length} warning(s) (see "!" lines above).` : 'Done! The server is set up.');
  console.log('Next: keep the bot running (npm start) so Verify, roles, tickets and YouTube posts work.');
  await client.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
