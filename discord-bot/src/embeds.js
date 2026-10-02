'use strict';
// The pinned info messages. `npm run setup` posts each one once, then edits it in place on later runs.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { BRAND, SITE, DONATE_URL, YOUTUBE_URL, EMAILS } = require('./config');

const FOOTER = { text: 'Tree Host · treehost.online' };

function base(guild) {
  const e = new EmbedBuilder().setColor(BRAND).setFooter({ ...FOOTER, iconURL: guild.iconURL() || undefined });
  if (guild.iconURL()) e.setThumbnail(guild.iconURL({ size: 256 }));
  return e;
}

const row = (...buttons) => new ActionRowBuilder().addComponents(...buttons);
const link = (label, url, emoji) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url).setEmoji(emoji);

const STATUS = {
  prelaunch: { icon: '🟡', label: 'Pre-launch', color: 0xf5b50a, text: "Tree Host isn't live yet." },
  online: { icon: '🟢', label: 'All systems operational', color: BRAND, text: 'Everything is running normally.' },
  maintenance: { icon: '🔧', label: 'Maintenance', color: 0x4fa3f7, text: 'Planned maintenance is in progress.' },
  degraded: { icon: '🟠', label: 'Some problems', color: 0xf39c12, text: "Some servers or features aren't working right." },
  outage: { icon: '🔴', label: 'Outage', color: 0xe74c3c, text: "Tree Host is down. We're working on it." },
};

/** "🟩🟩🟩⬜⬜⬜⬜⬜⬜⬜" for raised / target */
function progressBar(raised, target) {
  const n = Math.max(0, Math.min(10, Math.round((raised / target) * 10)));
  return '🟩'.repeat(n) + '⬜'.repeat(10 - n);
}

function goalLine(goal) {
  const target = (goal && goal.target) || 50;
  if (!goal || !(goal.raised > 0)) return `🎯 **Goal: $${target}** to get started`;
  const done = goal.raised >= target ? '\n🎉 **Goal reached! Thank you all!**' : '';
  return `🎯 **$${goal.raised} of $${target} raised**\n${progressBar(goal.raised, target)}${done}`;
}

function statusText(status, ch, role) {
  const st = STATUS[(status && status.state) || 'prelaunch'];
  const msg = (status && status.message) || st.text;
  const when = status && status.updatedAt ? `\n\n*Updated <t:${Math.floor(status.updatedAt / 1000)}:R>*` : '';
  return `${st.icon} **${st.label}**\n${msg}${when}\n\nOutages and maintenance are posted here. Get pinged with ${role('pingStatus')} in ${ch('roles')}.`;
}

/**
 * ch(key) -> "<#channel id>", role(key) -> "<@&role id>".
 * data.goal = { raised, target } and data.status = { state, message, updatedAt } come from state.json (/goal, /status).
 */
const build = (guild, ch, role, data = {}) => ({
  welcome: {
    embeds: [
      base(guild)
        .setTitle('🌳 Welcome to Tree Host!')
        .setDescription(
          'Tree Host is Minecraft server hosting, built from scratch. Pick any server type and version, and your ' +
            'server is running in about a minute.\n\n' +
            `**1.** Read the ${ch('rules')}\n` +
            '**2.** Press **Verify** below to unlock the whole server\n' +
            `**3.** Pick your pings in ${ch('roles')}\n\n` +
            `Questions? Check the ${ch('faq')} or open a ticket in ${ch('getHelp')}.`,
        ),
    ],
    components: [
      row(
        new ButtonBuilder().setCustomId('verify').setStyle(ButtonStyle.Success).setLabel('Verify').setEmoji('✅'),
        link('Website', SITE, '🌐'),
        link('YouTube', YOUTUBE_URL, '🎬'),
      ),
    ],
  },

  rules: {
    embeds: [
      base(guild)
        .setTitle('📜 Server rules')
        .setDescription(
          [
            '**1. Be respectful.** No harassment, hate speech, slurs or personal attacks.',
            '**2. No spam.** No message floods, mass mentions or repeated self-promotion.',
            '**3. Keep it safe for work.** No NSFW, gore or shock content anywhere.',
            '**4. No advertising.** No server invites or ads without staff permission.',
            '**5. No scams or cheats.** No phishing links, "free Nitro", hacked clients or griefing tools.',
            '**6. Protect your privacy.** Never share passwords, tokens or personal info. Staff will **never** ask for your password.',
            '**7. Use the right channel.** Support goes in tickets, not in DMs to staff.',
            '**8. Follow Discord\'s rules.** The [Discord Terms](https://discord.com/terms), [Community Guidelines](https://discord.com/guidelines) and the [Minecraft EULA](https://www.minecraft.net/eula) apply here.',
            '',
            'Staff may remove messages or members to keep the server safe. Breaking rules can mean a timeout, kick or ban.',
          ].join('\n'),
        ),
    ],
  },

  roles: {
    embeds: [
      base(guild)
        .setTitle('🎭 Pick your pings')
        .setDescription(
          'Choose what you want to be pinged for. Press a button to add the role; press it again to remove it.\n\n' +
            `📢 **Announcements**: big Tree Host news in ${ch('announcements')}\n` +
            `🎬 **YouTube**: new videos in ${ch('youtube')}\n` +
            `📊 **Status Updates**: outages and maintenance in ${ch('status')}\n` +
            `🔔 **Bump Reminder**: a ping in ${ch('bump')} when it's time to bump the server`,
        ),
    ],
    components: [
      row(
        new ButtonBuilder().setCustomId('role:pingAnnouncements').setStyle(ButtonStyle.Secondary).setLabel('Announcements').setEmoji('📢'),
        new ButtonBuilder().setCustomId('role:pingYoutube').setStyle(ButtonStyle.Secondary).setLabel('YouTube').setEmoji('🎬'),
        new ButtonBuilder().setCustomId('role:pingStatus').setStyle(ButtonStyle.Secondary).setLabel('Status Updates').setEmoji('📊'),
        new ButtonBuilder().setCustomId('role:pingBump').setStyle(ButtonStyle.Secondary).setLabel('Bump Reminder').setEmoji('🔔'),
      ),
    ],
  },

  youtube: {
    embeds: [
      base(guild)
        .setColor(0xff0033)
        .setTitle('🎬 Tree Host on YouTube')
        .setURL(YOUTUBE_URL)
        .setDescription(
          'Devlogs, behind the scenes of building a hosting company, and Minecraft server tips.\n\n' +
            '📺 Every new video and Short is posted here automatically.\n' +
            `🔔 Want a ping when one drops? Pick ${role('pingYoutube')} in ${ch('roles')}.`,
        ),
    ],
    components: [row(
      link('Subscribe', `${YOUTUBE_URL}?sub_confirmation=1`, '🔔'),
      link('Visit the channel', YOUTUBE_URL, '▶️'),
    )],
  },

  bump: {
    embeds: [
      base(guild)
        .setTitle('⏫ Help people find Tree Host')
        .setDescription(
          'Tree Host is listed on **DISBOARD**, a site where people find Discord servers. Every bump pushes us back to ' +
            'the top of the list for a while.\n\n' +
            '**How:** type `/bump` here and pick the one from **DISBOARD**.\n' +
            '**When:** once every 2 hours. The bot posts here when the next bump is ready.\n\n' +
            `🔔 Want a ping when it's time? Pick ${role('pingBump')} in ${ch('roles')}.\n` +
            "*Bumping is just a nice way to help: there are no rewards for it (DISBOARD doesn't allow them).*",
        ),
    ],
  },

  faq: {
    embeds: [
      base(guild)
        .setTitle('❓ Frequently asked questions')
        .addFields(
          { name: 'What is Tree Host?', value: 'Minecraft server hosting we built from scratch: a website, a dashboard and isolated servers. Pick a plan, pick a server type, play.' },
          { name: 'Is it live yet?', value: `Not yet. We're getting our first real server. Follow ${ch('announcements')} for launch news.` },
          { name: 'Which server types?', value: 'Paper, Purpur, Folia, Spigot, CraftBukkit, Vanilla, Fabric, Velocity, Waterfall and BungeeCord, any version. The right Java version is picked for you.' },
          { name: 'How much does it cost?', value: `Plans start at $5 a month. See ${ch('plans')}.` },
          { name: 'What do I get?', value: 'A live console in your browser, one-click plugins from Modrinth, a file manager, backups, and your own server address.' },
          { name: 'How do I get help?', value: `Open a private ticket in ${ch('getHelp')}, ask in ${ch('helpChat')}, or email **${EMAILS.support}**. Billing questions: **${EMAILS.billing}**.` },
          { name: "I'm a creator. Can I feature Tree Host?", value: `Yes, please! We give creators footage, scripts and a free server. Email **${EMAILS.promo}** or open a ticket.` },
          { name: 'How can I support Tree Host?', value: `See ${ch('launchFund')}, or share our videos!` },
        ),
    ],
  },

  plans: {
    embeds: [
      base(guild)
        .setTitle('💰 Plans')
        .setDescription('One plan = one server. Every feature is in every plan. No setup fees, cancel any time.\n*Launching soon at treehost.online.*')
        .addFields(
          { name: '🌱 Sapling: $5/month', value: '2 GB RAM · 1 CPU core · 15 GB NVMe\nSmall survival worlds, about 1-5 players', inline: true },
          { name: '🌳 Oak: $9/month', value: '4 GB RAM · 2 CPU cores · 30 GB NVMe\nFriends servers and light modpacks, about 5-20 players', inline: true },
          { name: '🌲 Redwood: $16/month', value: '8 GB RAM · 3 CPU cores · 60 GB NVMe\nCommunities and bigger modpacks, about 20-60 players', inline: true },
          { name: 'Every plan includes', value: 'Any server type and version · live console · one-click plugins · file manager · manual and automatic backups · restart after a crash · isolated server' },
        ),
    ],
    components: [row(link('treehost.online', SITE, '🌐'))],
  },

  launchFund: {
    embeds: [
      base(guild)
        .setTitle('💚 Help us launch Tree Host')
        .setDescription(
          'The website, dashboard and billing are built. What we need now is a real server to run it all on.\n\n' +
            `${goalLine(data.goal)}\n\n` +
            `Every dollar helps, and so does sharing our videos. Donors get the ${role('supporter')} role: just open a ticket in ${ch('getHelp')} after donating.`,
        ),
    ],
    components: [row(link('Donate', DONATE_URL, '💚'), link('Watch the video', YOUTUBE_URL, '🎬'))],
  },

  status: {
    embeds: [
      base(guild)
        .setTitle('📊 Tree Host status')
        .setColor(STATUS[(data.status && data.status.state) || 'prelaunch'].color)
        .setDescription(statusText(data.status, ch, role)),
    ],
  },

  getHelp: {
    embeds: [
      base(guild)
        .setTitle('🎫 Need help?')
        .setDescription(
          'Press **Open a ticket** to get a private channel with the Tree Host team.\n\n' +
            '**Please include:** your server name, what you expected, what happened, and any error from the console.\n\n' +
            `For quick questions, try ${ch('helpChat')} first. Prefer email? **${EMAILS.support}** (billing: **${EMAILS.billing}**).\n` +
            '🔒 Staff will **never** ask for your password.',
        ),
    ],
    components: [row(new ButtonBuilder().setCustomId('ticket:open').setStyle(ButtonStyle.Primary).setLabel('Open a ticket').setEmoji('🎫'))],
  },
});

module.exports = build;
module.exports.STATUS = STATUS;
