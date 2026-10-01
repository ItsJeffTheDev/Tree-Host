'use strict';
// The whole Tree Host Discord server, described as data. `npm run setup` makes the server match this file,
// so to change the server: edit here, then run setup again (it updates what exists, creates what's missing).

const BRAND = 0x46c37b;
const SITE = 'https://treehost.online';
const DONATE_URL = 'https://buy.stripe.com/00wcN7cfK3Jh9lEgEf0oM00';
const YOUTUBE_URL = 'https://www.youtube.com/@TreeHost';
// DISBOARD's bot (the server listing you /bump). Setup lets it see #bump; the bot reminds people 2 hours after a bump.
const DISBOARD_BOT_ID = '302050872383242240';
const BUMP_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// Top to bottom, as they appear in the member list. Permissions are server-wide; channel access is below.
const ROLES = [
  { key: 'founder', name: 'Founder', color: 0xf5b50a, hoist: true, permissions: ['Administrator'] },
  { key: 'admin', name: 'Admin', color: 0xe74c3c, hoist: true, permissions: ['Administrator'] },
  {
    key: 'moderator', name: 'Moderator', color: 0x4fa3f7, hoist: true,
    permissions: ['KickMembers', 'BanMembers', 'ModerateMembers', 'ManageMessages', 'ManageThreads', 'ManageNicknames',
      'MoveMembers', 'MuteMembers', 'DeafenMembers', 'ViewAuditLog'],
  },
  {
    key: 'support', name: 'Support Team', color: BRAND, hoist: true,
    permissions: ['ManageMessages', 'ModerateMembers', 'ManageThreads', 'MoveMembers'],
  },
  // Every bot in the server gets this (setup assigns it), so bots are grouped together in the member list.
  { key: 'bots', name: 'Bots', color: 0x5865f2, hoist: true, permissions: [], bots: true },
  { key: 'supporter', name: 'Supporter 💚', color: 0x7beaa6, hoist: true, permissions: [] },
  { key: 'customer', name: 'Customer', color: 0x2ecc71, hoist: true, permissions: [] },
  { key: 'member', name: 'Member', color: 0x93a398, hoist: false, permissions: [] },
  // Ping roles people pick themselves in #roles (not mentionable by members, so they can't be abused)
  { key: 'pingAnnouncements', name: '📢 Announcements', color: 0, hoist: false, permissions: [], ping: true },
  { key: 'pingYoutube', name: '🎬 YouTube', color: 0, hoist: false, permissions: [], ping: true },
  { key: 'pingStatus', name: '📊 Status Updates', color: 0, hoist: false, permissions: [], ping: true },
  { key: 'pingBump', name: '🔔 Bump Reminder', color: 0, hoist: false, permissions: [], ping: true },
];

const STAFF = ['founder', 'admin', 'moderator', 'support'];

// What @everyone gets server-wide. Channel access is then opened/closed per category with `access`.
const EVERYONE_PERMISSIONS = [
  'ViewChannel', 'ReadMessageHistory', 'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'AddReactions',
  'EmbedLinks', 'AttachFiles', 'UseExternalEmojis', 'UseExternalStickers', 'UseApplicationCommands', 'Connect', 'Speak',
  'Stream', 'UseVAD', 'UseSoundboard', 'ChangeNickname', 'CreateInstantInvite',
];

/**
 * Access presets (who can see / talk). Unverified people only see the INFORMATION category until they press Verify.
 *   open:             everyone (even unverified) reads + posts; Onboarding needs one such channel
 *   info:             everyone reads, only staff post
 *   members:          verified members read + post
 *   membersReadonly:  verified members read, only staff post
 *   membersForum:     verified members can open posts (forum) but not chat in the channel itself
 *   voice:            verified members join and talk
 *   afk:              verified members can join, nobody can talk
 *   staff:            staff only
 */
const CATEGORIES = [
  {
    key: 'info', name: '📌 INFORMATION', access: 'info',
    channels: [
      { key: 'welcome', name: '✅・verify', topic: 'Welcome to Tree Host! Press Verify to unlock the server.', embed: 'welcome' },
      { key: 'rules', name: '📜・rules', topic: 'Read these before chatting.', embed: 'rules' },
      { key: 'announcements', name: '📢・announcements', type: 'announcement', topic: 'News and updates about Tree Host.' },
      { key: 'youtube', name: '🎬・youtube', type: 'announcement', topic: 'New Tree Host videos are posted here automatically.', embed: 'youtube' },
      { key: 'roles', name: '🎭・roles', topic: 'Pick the pings you want.', embed: 'roles' },
      { key: 'faq', name: '❓・faq', topic: 'Common questions about Tree Host.', embed: 'faq' },
    ],
  },
  {
    key: 'treehost', name: '🌳 TREE HOST', access: 'info',
    channels: [
      { key: 'plans', name: '💰・plans', topic: 'Plans and pricing.', embed: 'plans' },
      { key: 'launchFund', name: '💚・launch-fund', topic: 'Help us get our first server and go live.', embed: 'launchFund' },
      { key: 'status', name: '📊・status', type: 'announcement', topic: 'Is Tree Host up? Outages and maintenance are posted here.', embed: 'status' },
      {
        key: 'suggestions', name: '💡・suggestions', type: 'forum', access: 'membersForum',
        topic: 'One post per idea. Upvote ideas you like with a reaction.',
        tags: [{ name: 'Feature', emoji: '✨' }, { name: 'Plugin / Mod', emoji: '🧩' }, { name: 'Website', emoji: '🌐' },
          { name: 'Planned', emoji: '🗓️', moderated: true }, { name: 'Done', emoji: '✅', moderated: true }],
      },
    ],
  },
  {
    key: 'community', name: '💬 COMMUNITY', access: 'members',
    channels: [
      { key: 'general', name: '💬・general', topic: 'Talk about anything (keep it friendly).' },
      { key: 'minecraft', name: '⛏️・minecraft', topic: 'Builds, mods, plugins, versions: all things Minecraft.' },
      { key: 'showcase', name: '🏗️・showcase', topic: 'Show off your builds and servers. Screenshots welcome!', slowmode: 30 },
      { key: 'offTopic', name: '🎲・off-topic', topic: 'Memes and everything else.' },
      // Open to everyone: Discord's Onboarding (Server Settings → Onboarding) needs one channel new people can talk in.
      { key: 'botCommands', name: '🤖・bot-commands', access: 'open', topic: 'Use bot commands here.' },
      { key: 'bump', name: '⏫・bump', topic: 'Run /bump every 2 hours to help people find Tree Host on DISBOARD.', embed: 'bump' },
    ],
  },
  {
    key: 'helpdesk', name: '🎫 SUPPORT', access: 'members',
    channels: [
      { key: 'getHelp', name: '🎫・get-help', access: 'membersReadonly', topic: 'Open a private ticket with the Tree Host team.', embed: 'getHelp' },
      { key: 'helpChat', name: '🆘・help-chat', topic: 'Quick questions: the community and staff can help here.', slowmode: 5 },
    ],
  },
  {
    key: 'voice', name: '🔊 VOICE', access: 'voice',
    channels: [
      { key: 'vcLounge', name: '🔊 Lounge', type: 'voice' },
      { key: 'vcMc1', name: '⛏️ Minecraft 1', type: 'voice' },
      { key: 'vcMc2', name: '⛏️ Minecraft 2', type: 'voice' },
      { key: 'vcChill', name: '🎧 Chill', type: 'voice', userLimit: 10 },
      { key: 'vcAfk', name: '💤 AFK', type: 'voice', access: 'afk' },
    ],
  },
  {
    key: 'staff', name: '🛠️ STAFF', access: 'staff',
    channels: [
      { key: 'staffChat', name: '💼・staff-chat', topic: 'Staff only.' },
      { key: 'modLog', name: '🧾・mod-log', topic: 'AutoMod alerts, joins and moderation logs.' },
      { key: 'ticketLog', name: '🗃️・ticket-log', topic: 'Transcripts of closed tickets.' },
      { key: 'vcStaff', name: '🔒 Staff', type: 'voice' },
    ],
  },
];

const SERVER = {
  name: 'Tree Host',
  icon: '../public/brand/tree-host-logo-512.png', // relative to the discord-bot folder
  verificationLevel: 'Medium',          // accounts must be registered for 5+ minutes
  explicitContentFilter: 'AllMembers',  // Discord scans images from everyone
  defaultMessageNotifications: 'OnlyMentions',
  afkChannel: 'vcAfk',
  afkTimeout: 300,
  systemChannel: 'modLog',              // Discord's join/boost messages go to the staff log, not chat
  community: { rulesChannel: 'rules', publicUpdatesChannel: 'staffChat' },
};

// The bot's own Discord profile (About Me + app tags). Setup applies it.
const BOT_PROFILE = {
  description: [
    '🌳 The official Tree Host bot.',
    'Tree Host is Minecraft server hosting, built from scratch.',
    '',
    '✅ Verification · 🎫 Support tickets · 🎬 YouTube alerts · ⏫ Bump reminders · 📊 Status updates',
    '',
    '🌐 treehost.online',
    '🎬 youtube.com/@TreeHost',
  ].join('\n'),
  tags: ['minecraft', 'server hosting', 'tickets', 'moderation', 'notifications'], // max 5, 20 characters each
};

// Custom statuses the bot rotates through (every 2 minutes). {goal} becomes the launch fund progress.
const STATUSES = [
  '🌳 Minecraft hosting, built from scratch',
  '{goal}',
  '⛏️ Type /help · treehost.online',
  '🎬 New videos land in #youtube',
  '🎫 Need help? Open a ticket',
];

// AutoMod. Staff roles and staff channels are exempt from every rule.
const AUTOMOD = [
  {
    name: 'Tree Host: slurs & sexual content', trigger: 'KeywordPreset', presets: ['Slurs', 'SexualContent'],
    block: 'That message was blocked: slurs and sexual content are not allowed here.', alert: true,
  },
  { name: 'Tree Host: spam', trigger: 'Spam', block: 'That message looks like spam.', alert: true },
  {
    name: 'Tree Host: mention spam', trigger: 'MentionSpam', mentionLimit: 5, raidProtection: true,
    block: 'Too many mentions in one message.', alert: true, timeoutSeconds: 600,
  },
  {
    name: 'Tree Host: invite links', trigger: 'Keyword',
    regex: ['(discord\\.gg|discord(app)?\\.com/invite|dsc\\.gg)/\\S+'],
    block: 'Server invites are not allowed. Ask staff if you want to share one.', alert: true,
  },
  {
    name: 'Tree Host: scams', trigger: 'Keyword',
    keywords: ['*free nitro*', '*nitro for free*', '*free discord nitro*', '*steam gift card*', '*claim your nitro*', '*airdrop*'],
    regex: [
      'd[i1l!]s[ck]{1,2}[o0]r[cdt]{1,2}[-.]?(gift|nitro|app|give)s?\\.(com|ru|gift|xyz|site|link|org|net)',
      'st[e3]am-?c[o0]m{1,2}un[i1l]t[yi]\\.(ru|xyz|gift|link|site|org|net|top)',
      'gift-?nitro\\.\\w+',
    ],
    block: 'That message was blocked because it looks like a scam. Staff have been told.', alert: true, timeoutSeconds: 3600,
  },
  {
    name: 'Tree Host: account safety', trigger: 'Keyword',
    keywords: ['*send me your password*', '*give me your password*', '*your login details*', '*send your token*'],
    block: 'Never share passwords or tokens. Tree Host staff will never ask for them.', alert: true,
  },
];

module.exports = { BOT_PROFILE, STATUSES, BRAND, SITE, DONATE_URL, YOUTUBE_URL, DISBOARD_BOT_ID, BUMP_COOLDOWN_MS, ROLES, STAFF, EVERYONE_PERMISSIONS, CATEGORIES, SERVER, AUTOMOD };
