'use strict';
// Slash commands. Admin commands need "Manage Server" (Founder/Admin); staff commands need "Manage Messages"
// (Moderator/Support Team too). Discord hides commands from people who can't use them.
const {
  SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, ChannelType, EmbedBuilder, MessageFlags,
} = require('discord.js');
const { BRAND } = require('./config');
const { STATUS } = require('./embeds');

const ADMIN = PermissionFlagsBits.ManageGuild;
const STAFF = PermissionFlagsBits.ManageMessages;
const cmd = (name, description, perms) => {
  const c = new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);
  if (perms) c.setDefaultMemberPermissions(perms);
  return c;
};

const definitions = [
  cmd('help', 'Show the Tree Host bot commands'),
  cmd('announce', 'Post an announcement in #announcements', ADMIN)
    .addStringOption((o) => o.setName('title').setDescription('Headline').setRequired(true).setMaxLength(256))
    .addStringOption((o) => o.setName('message').setDescription('Text (use \\n for a new line)').setRequired(true).setMaxLength(4000))
    .addBooleanOption((o) => o.setName('ping').setDescription('Ping the 📢 Announcements role (default: yes)'))
    .addAttachmentOption((o) => o.setName('image').setDescription('Optional image')),
  cmd('status', 'Update #status (online, maintenance, outage...)', ADMIN)
    .addStringOption((o) => o.setName('state').setDescription('Current state').setRequired(true)
      .addChoices(...Object.entries(STATUS).map(([value, s]) => ({ name: `${s.icon} ${s.label}`, value }))))
    .addStringOption((o) => o.setName('message').setDescription('What is happening (optional)').setMaxLength(1000))
    .addBooleanOption((o) => o.setName('ping').setDescription('Ping the 📊 Status Updates role (default: yes)')),
  cmd('goal', 'Update the launch fund progress bar', ADMIN)
    .addNumberOption((o) => o.setName('raised').setDescription('Total raised so far, in dollars').setRequired(true).setMinValue(0))
    .addNumberOption((o) => o.setName('target').setDescription('Goal in dollars (default 50)').setMinValue(1))
    .addBooleanOption((o) => o.setName('announce').setDescription('Also post the update in #announcements')),
  cmd('supporter', 'Give someone the Supporter 💚 role (donors)', ADMIN)
    .addUserOption((o) => o.setName('user').setDescription('Who donated').setRequired(true))
    .addBooleanOption((o) => o.setName('thank').setDescription('Post a public thank-you in #general (default: yes)')),
  cmd('say', 'Make the bot post a message', ADMIN)
    .addStringOption((o) => o.setName('message').setDescription('Text (use \\n for a new line)').setRequired(true).setMaxLength(2000))
    .addChannelOption((o) => o.setName('channel').setDescription('Where (default: here)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  cmd('youtube-check', 'Check for new Tree Host videos right now', ADMIN),
  cmd('youtube-post', 'Post a Tree Host video in #youtube as an embed', ADMIN)
    .addStringOption((o) => o.setName('video').setDescription('Video link or ID (default: the newest upload)'))
    .addBooleanOption((o) => o.setName('ping').setDescription('Ping the 🎬 YouTube role (default: no)')),
  cmd('setup', 'Re-run the server setup (roles, channels, embeds, AutoMod)', ADMIN),
  cmd('customer', 'Give someone the Customer role', STAFF)
    .addUserOption((o) => o.setName('user').setDescription('The customer').setRequired(true)),
  cmd('ticket', 'Manage the ticket you are in', STAFF)
    .addSubcommand((s) => s.setName('add').setDescription('Add someone to this ticket')
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove someone from this ticket')
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
    .addSubcommand((s) => s.setName('close').setDescription('Close this ticket (saves a transcript)')),
  cmd('purge', 'Delete recent messages in this channel', STAFF)
    .addIntegerOption((o) => o.setName('amount').setDescription('How many (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)),
  cmd('slowmode', 'Set slowmode for this channel', STAFF)
    .addIntegerOption((o) => o.setName('seconds').setDescription('0 turns it off (max 21600)').setRequired(true).setMinValue(0).setMaxValue(21600)),
];

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const lines = (s) => s.replace(/\\n/g, '\n');

/** ctx: { state, save, role, channel, refreshEmbed, closeTicket, checkYoutube, runSetup } */
async function handle(i, ctx) {
  const { state, save, role, channel } = ctx;
  switch (i.commandName) {
    case 'help': {
      const staff = i.memberPermissions.has(STAFF);
      const admin = i.memberPermissions.has(ADMIN);
      const out = ['**Tree Host bot**', `Verify in <#${channel('welcome')}> · pings in <#${channel('roles')}> · help in <#${channel('getHelp')}>`];
      if (staff) out.push('', '**Staff**', '`/ticket add|remove|close` · `/customer` · `/purge` · `/slowmode`');
      if (admin) out.push('', '**Admin**', '`/announce` · `/status` · `/goal` · `/supporter` · `/say` · `/youtube-check` · `/youtube-post` · `/setup`');
      return i.reply(ephemeral(out.join('\n')));
    }

    case 'announce': {
      const ch = await i.guild.channels.fetch(channel('announcements'));
      const ping = i.options.getBoolean('ping') ?? true;
      const image = i.options.getAttachment('image');
      const embed = new EmbedBuilder().setColor(BRAND).setTitle(i.options.getString('title'))
        .setDescription(lines(i.options.getString('message'))).setTimestamp()
        .setFooter({ text: `Posted by ${i.member.displayName}`, iconURL: i.user.displayAvatarURL() });
      if (image && (image.contentType || '').startsWith('image/')) embed.setImage(image.url);
      const msg = await ch.send({
        content: ping && role('pingAnnouncements') ? `<@&${role('pingAnnouncements')}>` : undefined,
        embeds: [embed], allowedMentions: { roles: ping ? [role('pingAnnouncements')].filter(Boolean) : [] },
      });
      if (ch.type === ChannelType.GuildAnnouncement) await msg.crosspost().catch(() => {});
      return i.reply(ephemeral(`Posted: ${msg.url}`));
    }

    case 'status': {
      const st = i.options.getString('state');
      const message = i.options.getString('message');
      const ping = i.options.getBoolean('ping') ?? true;
      state.status = { state: st, message: message || null, updatedAt: Date.now() };
      save();
      await ctx.refreshEmbed('status');
      const s = STATUS[st];
      const ch = await i.guild.channels.fetch(channel('status'));
      const msg = await ch.send({
        content: `${ping && role('pingStatus') ? `<@&${role('pingStatus')}> ` : ''}${s.icon} **${s.label}**${message ? `: ${lines(message)}` : ''}`,
        allowedMentions: { roles: ping ? [role('pingStatus')].filter(Boolean) : [] },
      });
      if (ch.type === ChannelType.GuildAnnouncement) await msg.crosspost().catch(() => {});
      return i.reply(ephemeral(`Status is now ${s.icon} ${s.label}.`));
    }

    case 'goal': {
      const raised = Math.round(i.options.getNumber('raised') * 100) / 100;
      const target = i.options.getNumber('target') ?? (state.goal && state.goal.target) ?? 50;
      const before = (state.goal && state.goal.raised) || 0;
      state.goal = { raised, target };
      save();
      await ctx.refreshEmbed('launchFund');
      if (i.options.getBoolean('announce')) {
        const ch = await i.guild.channels.fetch(channel('announcements'));
        const reached = raised >= target && before < target;
        const msg = await ch.send({
          content: role('pingAnnouncements') ? `<@&${role('pingAnnouncements')}>` : undefined,
          allowedMentions: { roles: [role('pingAnnouncements')].filter(Boolean) },
          embeds: [new EmbedBuilder().setColor(BRAND)
            .setTitle(reached ? '🎉 We hit the launch goal!' : '💚 Launch fund update')
            .setDescription(reached
              ? `We raised **$${raised}**: Tree Host is getting a real server! Thank you to everyone who donated and shared. 🌳`
              : `**$${raised} of $${target}** raised so far. Thank you! See <#${channel('launchFund')}> to help.`)],
        });
        if (ch.type === ChannelType.GuildAnnouncement) await msg.crosspost().catch(() => {});
      }
      return i.reply(ephemeral(`Launch fund updated: $${raised} of $${target}.`));
    }

    case 'supporter': {
      const member = await i.guild.members.fetch(i.options.getUser('user').id);
      await member.roles.add(role('supporter'), `Supporter role from ${i.user.tag}`);
      if (i.options.getBoolean('thank') ?? true) {
        const general = await i.guild.channels.fetch(channel('general')).catch(() => null);
        if (general) await general.send({ content: `💚 Huge thanks to ${member} for supporting Tree Host!`, allowedMentions: { users: [member.id] } });
      }
      return i.reply(ephemeral(`${member} is now a <@&${role('supporter')}>.`));
    }

    case 'customer': {
      const member = await i.guild.members.fetch(i.options.getUser('user').id);
      await member.roles.add(role('customer'), `Customer role from ${i.user.tag}`);
      return i.reply(ephemeral(`${member} is now a <@&${role('customer')}>.`));
    }

    case 'say': {
      const ch = i.options.getChannel('channel') || i.channel;
      const msg = await ch.send({ content: lines(i.options.getString('message')), allowedMentions: { parse: [] } });
      return i.reply(ephemeral(`Sent: ${msg.url}`));
    }

    case 'youtube-check': {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const posted = await ctx.checkYoutube();
      return i.editReply(posted ? `Posted ${posted} new video(s) in <#${channel('youtube')}>.` : 'No new videos.');
    }

    case 'youtube-post': {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const videos = await ctx.fetchVideos();
      const want = i.options.getString('video');
      const id = want && (/(?:v=|shorts\/|youtu\.be\/)([\w-]{11})/.exec(want) || [null, want.trim()])[1];
      const v = id ? videos.find((x) => x.id === id) : videos[0];
      if (!v) return i.editReply(id ? "That video isn't in the channel's feed (the feed has the 15 newest uploads)." : 'No videos found.');
      const msg = await ctx.postVideo(v, i.options.getBoolean('ping') ?? false);
      return i.editReply(`Posted: ${msg.url}`);
    }

    case 'setup': {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const out = await ctx.runSetup();
      return i.editReply('```\n' + out.slice(-1900) + '\n```');
    }

    case 'ticket': {
      const owner = (i.channel.topic || '').startsWith('ticket:') ? i.channel.topic.slice(7) : null;
      if (!owner) return i.reply(ephemeral('Use this inside a ticket channel.'));
      const sub = i.options.getSubcommand();
      if (sub === 'close') return ctx.closeTicket(i);
      const user = i.options.getUser('user');
      if (sub === 'add') {
        await i.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
        return i.reply({ content: `Added ${user} to this ticket.`, allowedMentions: { users: [user.id] } });
      }
      if (user.id === owner) return i.reply(ephemeral("You can't remove the person who opened the ticket. Close it instead."));
      await i.channel.permissionOverwrites.delete(user.id);
      return i.reply({ content: `Removed ${user} from this ticket.`, allowedMentions: { parse: [] } });
    }

    case 'purge': {
      const n = i.options.getInteger('amount');
      const deleted = await i.channel.bulkDelete(n, true);
      return i.reply(ephemeral(`Deleted ${deleted.size} message(s).${deleted.size < n ? ' (Discord only lets bots bulk-delete messages from the last 14 days.)' : ''}`));
    }

    case 'slowmode': {
      const sec = i.options.getInteger('seconds');
      if (!('setRateLimitPerUser' in i.channel) || i.channel.type === ChannelType.GuildAnnouncement) return i.reply(ephemeral("This channel doesn't support slowmode."));
      await i.channel.setRateLimitPerUser(sec, `Set by ${i.user.tag}`);
      return i.reply(ephemeral(sec ? `Slowmode set to ${sec}s.` : 'Slowmode is off.'));
    }

    default:
      return i.reply(ephemeral('Unknown command.'));
  }
}

module.exports = { definitions, handle };
