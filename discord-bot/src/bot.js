'use strict';
// The always-on part of the Tree Host bot: Verify button, ping-role buttons, support tickets, and posting new
// YouTube videos. Run `npm run setup` once first (it creates the channels, roles and buttons this uses).
const {
  Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  AttachmentBuilder, MessageFlags, ActivityType,
} = require('discord.js');
const path = require('path');
const { spawn } = require('child_process');
const { BRAND, STAFF, DISBOARD_BOT_ID, BUMP_COOLDOWN_MS, STATUSES } = require('./config');
const { loadEnv, requireEnv, loadState, saveState, ROOT } = require('./util');
const buildEmbeds = require('./embeds');
const commands = require('./commands');
const youtube = require('./youtube');

loadEnv();
requireEnv('DISCORD_TOKEN', 'DISCORD_GUILD_ID');
const state = loadState();
if (!state.roles.member) {
  console.error('Run "npm run setup" first: it creates the roles and channels the bot needs.');
  process.exit(1);
}
const role = (k) => state.roles[k];
const channel = (k) => state.channels[k];
const isStaff = (member) => member.permissions.has(PermissionFlagsBits.Administrator) || STAFF.some((k) => member.roles.cache.has(role(k)));
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// GuildMessages (not privileged) lets the bot notice DISBOARD's reply to /bump.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('clientReady', async () => {
  console.log(`Tree Host bot online as ${client.user.tag}`);
  // Slash commands are registered for this server only, so changes show up instantly.
  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  await guild.commands.set(commands.definitions.map((c) => c.toJSON()));
  console.log(`Registered ${commands.definitions.length} slash commands: ${commands.definitions.map((c) => '/' + c.name).join(' ')}`);
  // On Windows, keep the PC from sleeping while the bot runs (the screen can still turn off).
  try {
    if (require(path.join(ROOT, '..', 'src', 'keepawake.js')).keepAwake()) console.log('This PC will stay awake while the bot runs.');
  } catch { /* not running from the Tree Host repo */ }
  scheduleBumpReminder();
  rotateStatus();
  setInterval(rotateStatus, 2 * 60 * 1000);
  if (process.env.YOUTUBE_CHANNEL_ID) {
    checkYoutube().catch((e) => console.error(`YouTube check failed: ${e.message}`));
    setInterval(() => checkYoutube().catch((e) => console.error(`YouTube check failed: ${e.message}`)), 10 * 60 * 1000);
  }
});

const ctx = {
  state,
  save: () => saveState(state),
  role,
  channel,
  closeTicket: (i) => closeTicket(i),
  checkYoutube: () => checkYoutube(),
  postVideo: (v, ping) => postVideo(v, ping),
  fetchVideos: () => youtube.fetchVideos(process.env.YOUTUBE_CHANNEL_ID),
  refreshEmbed,
  runSetup,
};

client.on('interactionCreate', async (i) => {
  if (i.guildId !== process.env.DISCORD_GUILD_ID) return;
  if (i.isChatInputCommand()) {
    try {
      console.log(`/${i.commandName} by ${i.user.tag}`);
      await commands.handle(i, ctx);
    } catch (e) {
      console.error(e);
      const msg = ephemeral(`That didn't work: ${e.message}`);
      if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
    return;
  }
  if (!i.isButton()) return;
  try {
    if (i.customId === 'verify') return await verify(i);
    if (i.customId.startsWith('role:')) return await togglePing(i, i.customId.slice(5));
    if (i.customId === 'ticket:open') return await openTicket(i);
    if (i.customId === 'ticket:close') return await closeTicket(i);
  } catch (e) {
    console.error(e);
    const msg = ephemeral('Something went wrong. Please tell a staff member.');
    if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
});

// ---------- verification ----------
async function verify(i) {
  if (i.member.roles.cache.has(role('member'))) return i.reply(ephemeral('You are already verified. Have fun! 🌳'));
  await i.member.roles.add(role('member'), 'Pressed Verify');
  await i.reply(ephemeral(`You're in! 🌳 Say hi in <#${channel('general')}> and pick your pings in <#${channel('roles')}>.`));
  const general = await i.guild.channels.fetch(channel('general')).catch(() => null);
  if (general) await general.send({ content: `Welcome to Tree Host, ${i.user}! 🌳`, allowedMentions: { users: [i.user.id] } });
}

// ---------- ping roles ----------
const PINGS = ['pingAnnouncements', 'pingYoutube', 'pingStatus', 'pingBump'];
async function togglePing(i, key) {
  if (!PINGS.includes(key) || !role(key)) return i.reply(ephemeral('That role does not exist anymore.'));
  const has = i.member.roles.cache.has(role(key));
  if (has) await i.member.roles.remove(role(key), 'Self-assigned ping role');
  else await i.member.roles.add(role(key), 'Self-assigned ping role');
  await i.reply(ephemeral(has ? `Removed <@&${role(key)}>. You won't be pinged for it anymore.` : `Added <@&${role(key)}>. You'll be pinged for it.`));
}

// ---------- tickets ----------
const ticketTopic = (userId) => `ticket:${userId}`;

async function openTicket(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = i.guild;
  await guild.channels.fetch();
  const existing = guild.channels.cache.find((c) => c.topic === ticketTopic(i.user.id));
  if (existing) return i.editReply(`You already have an open ticket: ${existing}`);
  const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks];
  const name = `ticket-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90) || `ticket-${i.user.id}`;
  const ch = await guild.channels.create({
    name, type: ChannelType.GuildText, parent: channel('helpdesk'), topic: ticketTopic(i.user.id),
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: i.user.id, allow },
      ...STAFF.filter(role).map((k) => ({ id: role(k), allow: [...allow, PermissionFlagsBits.ManageMessages] })),
    ],
    reason: `Ticket opened by ${i.user.tag}`,
  });
  await ch.send({
    content: `${i.user}${role('support') ? ` <@&${role('support')}>` : ''}`,
    allowedMentions: { users: [i.user.id], roles: [role('support')].filter(Boolean) },
    embeds: [
      new EmbedBuilder().setColor(BRAND).setTitle('🎫 Ticket opened')
        .setDescription('Thanks for reaching out! Tell us:\n• your server name\n• what you expected\n• what happened (and any error from the console)\n\nA team member will reply here. 🔒 We will **never** ask for your password.'),
    ],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:close').setStyle(ButtonStyle.Danger).setLabel('Close ticket').setEmoji('🔒'),
    )],
  });
  await i.editReply(`Your ticket is open: ${ch}`);
}

async function closeTicket(i) {
  const ch = i.channel;
  const owner = (ch.topic || '').startsWith('ticket:') ? ch.topic.slice(7) : null;
  if (!owner) return i.reply(ephemeral('This is not a ticket channel.'));
  if (i.user.id !== owner && !isStaff(i.member)) return i.reply(ephemeral('Only the person who opened this ticket or staff can close it.'));
  await i.reply('🔒 Closing this ticket in 5 seconds...');
  // Save a transcript to the staff ticket log before deleting.
  const lines = [];
  let before;
  for (let n = 0; n < 10; n++) {
    const batch = await ch.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    for (const m of batch.values()) {
      const extra = [...m.attachments.values()].map((a) => ` [file: ${a.url}]`).join('') + (m.embeds.length ? ' [embed]' : '');
      lines.push(`[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}${extra}`);
    }
    before = batch.last().id;
  }
  lines.reverse();
  const log = await i.guild.channels.fetch(channel('ticketLog')).catch(() => null);
  if (log) {
    await log.send({
      content: `🗃️ **${ch.name}** opened by <@${owner}>, closed by ${i.user}`,
      allowedMentions: { parse: [] },
      files: [new AttachmentBuilder(Buffer.from(lines.join('\n') || '(empty)', 'utf8'), { name: `${ch.name}.txt` })],
    });
  }
  setTimeout(() => ch.delete(`Ticket closed by ${i.user.tag}`).catch(() => {}), 5000);
}

// ---------- YouTube ----------
/** Posts new uploads to #youtube as an embed. Returns how many were posted. */
async function checkYoutube() {
  const videos = await youtube.fetchVideos(process.env.YOUTUBE_CHANNEL_ID);
  state.youtube = state.youtube || { seen: [] };
  const firstRun = !state.youtube.initialized;
  const fresh = videos.filter((v) => !state.youtube.seen.includes(v.id)).reverse(); // oldest first
  state.youtube.seen = [...new Set([...videos.map((v) => v.id), ...state.youtube.seen])].slice(0, 200);
  state.youtube.initialized = true;
  saveState(state);
  if (firstRun) {
    console.log(`YouTube: watching ${videos.length} existing video(s); new uploads will be posted.`);
    return 0;
  }
  for (const v of fresh) await postVideo(v, true);
  return fresh.length;
}

/** Posts one video embed to #youtube (and publishes it to servers following the channel). */
async function postVideo(v, ping) {
  const ch = await client.channels.fetch(channel('youtube'));
  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const msg = await ch.send(await youtube.videoMessage(v, { pingRoleId: role('pingYoutube'), iconURL: guild.iconURL(), ping }));
  if (ch.type === ChannelType.GuildAnnouncement) await msg.crosspost().catch(() => {});
  console.log(`YouTube: posted ${v.title}`);
  return msg;
}

// ---------- custom status ----------
let statusIndex = 0;
function rotateStatus() {
  const g = state.goal;
  const goal = g && g.raised > 0
    ? (g.raised >= g.target ? '🎉 Launch goal reached: thank you!' : `💚 $${g.raised} / $${g.target} raised: #launch-fund`)
    : '💚 Help us launch: #launch-fund';
  const text = STATUSES[statusIndex++ % STATUSES.length].replace('{goal}', goal);
  client.user.setPresence({ status: 'online', activities: [{ type: ActivityType.Custom, name: 'custom', state: text.slice(0, 128) }] });
}

// ---------- DISBOARD bump reminder ----------
// When DISBOARD answers a /bump, remind people in #bump two hours later. No rewards: DISBOARD doesn't allow them.
let bumpTimer = null;

client.on('messageCreate', async (m) => {
  if (m.guildId !== process.env.DISCORD_GUILD_ID || m.author.id !== DISBOARD_BOT_ID) return;
  const meta = m.interactionMetadata || m.interaction;
  if (!meta) return;
  if (m.interaction && m.interaction.commandName && m.interaction.commandName !== 'bump') return;
  const now = Date.now();
  // DISBOARD only lets a server bump every 2 hours; ignore anything inside that window (e.g. "please wait" replies).
  if (state.bump && now - state.bump.last < BUMP_COOLDOWN_MS - 5 * 60 * 1000) return;
  const user = meta.user;
  state.bump = { last: now, next: now + BUMP_COOLDOWN_MS, by: user ? user.id : null, reminded: false };
  saveState(state);
  console.log(`Bump by ${user ? user.tag : 'someone'}; reminder at ${new Date(state.bump.next).toLocaleTimeString()}`);
  const ch = channel('bump') && (await client.channels.fetch(channel('bump')).catch(() => null));
  if (ch) {
    await ch.send({
      content: `⏫ Thanks for bumping${user ? `, ${user}` : ''}! The next bump is ready <t:${Math.floor(state.bump.next / 1000)}:R>.`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
  scheduleBumpReminder();
});

function scheduleBumpReminder() {
  clearTimeout(bumpTimer);
  if (!state.bump || state.bump.reminded) return;
  bumpTimer = setTimeout(remindBump, Math.max(0, state.bump.next - Date.now()));
}

async function remindBump() {
  const ch = channel('bump') && (await client.channels.fetch(channel('bump')).catch(() => null));
  if (!ch) return;
  await ch.send({
    content: `${role('pingBump') ? `<@&${role('pingBump')}> ` : ''}⏫ **Time to bump!** Type \`/bump\` and pick the one from DISBOARD to help people find Tree Host.`,
    allowedMentions: { roles: [role('pingBump')].filter(Boolean) },
  });
  state.bump.reminded = true;
  saveState(state);
}

// ---------- helpers for commands ----------
/** Re-renders one of setup's info messages (e.g. status, launchFund) with the latest state. */
async function refreshEmbed(key) {
  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const embeds = buildEmbeds(guild, (k) => `<#${channel(k)}>`, (k) => `<@&${role(k)}>`, { goal: state.goal, status: state.status });
  const ch = await guild.channels.fetch(channel(key));
  const msg = state.messages[key] && (await ch.messages.fetch(state.messages[key]).catch(() => null));
  if (msg) await msg.edit({ ...embeds[key], components: embeds[key].components || [] });
  else { state.messages[key] = (await ch.send(embeds[key])).id; saveState(state); }
}

/** Runs `npm run setup` in a separate process and returns its output. */
function runSetup() {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(process.execPath, [path.join(__dirname, 'setup.js')], { cwd: ROOT, windowsHide: true });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', () => {
      Object.assign(state, loadState()); // pick up any new IDs setup saved
      // drop Node's deprecation notices, keep setup's own output
      resolve(out.split(/\r?\n/).filter((l) => !/^\(node:\d+\) Warning|^\(Use `node --trace-warnings/.test(l)).join('\n').trim());
    });
  });
}


client.login(process.env.DISCORD_TOKEN);
