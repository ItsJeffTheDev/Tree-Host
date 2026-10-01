'use strict';
// Reads the Tree Host YouTube feed and builds the Discord embed for a video.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { YOUTUBE_URL } = require('./config');

const YT_RED = 0xff0033;

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const tag = (xml, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]).trim() : '';
};
const attr = (xml, name, a) => {
  const m = new RegExp(`<${name}[^>]*\\s${a}="([^"]*)"`).exec(xml);
  return m ? decode(m[1]) : '';
};

/** Newest first: [{ id, title, url, short, published, description, views }] */
async function fetchVideos(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) throw new Error(`YouTube feed: HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const url = attr(e, 'link', 'href');
    return {
      id: tag(e, 'yt:videoId'),
      title: tag(e, 'title'),
      url,
      short: url.includes('/shorts/'),
      published: tag(e, 'published'),
      description: tag(e, 'media:description'),
      views: Number(attr(e, 'media:statistics', 'views')) || 0,
    };
  });
}

/** The first couple of lines of the description: no hashtags, links-only lines or upload notes. */
function teaser(description) {
  const text = description.split(/\n\s*={3,}/)[0]; // anything after a "=====" line is not for viewers
  const lines = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) { if (lines.length) lines.push(''); continue; }
    if (/^(#\w+\s*)+$/.test(l)) continue;          // hashtag lines
    if (/^\d{1,2}:\d{2}\s/.test(l)) break;         // chapters start: stop
    lines.push(l);
    if (lines.join('\n').length > 280) break;
  }
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > 300) out = out.slice(0, 297).replace(/\s+\S*$/, '') + '…';
  return out;
}

/** Best thumbnail that exists: the 1280x720 one when YouTube has made it, otherwise the standard one. */
async function thumbnail(id) {
  const max = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  const ok = await fetch(max, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
  return ok ? max : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/** Message for a new video: ping + embed + Watch / Subscribe buttons. */
async function videoMessage(v, { pingRoleId, iconURL, ping = true } = {}) {
  const kind = v.short ? '📱 New Short!' : '🎬 New video!';
  const embed = new EmbedBuilder()
    .setColor(YT_RED)
    .setAuthor({ name: 'Tree Host on YouTube', url: YOUTUBE_URL, iconURL: iconURL || undefined })
    .setTitle(v.title.slice(0, 256))
    .setURL(v.url)
    .setImage(await thumbnail(v.id))
    .setFooter({ text: v.short ? 'YouTube Shorts' : 'YouTube' })
    .setTimestamp(v.published ? new Date(v.published) : new Date());
  const text = teaser(v.description || '');
  if (text) embed.setDescription(text);
  return {
    content: `${ping && pingRoleId ? `<@&${pingRoleId}> ` : ''}**${kind}**`,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(v.short ? 'Watch the Short' : 'Watch now').setURL(v.url).setEmoji('▶️'),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Subscribe').setURL(`${YOUTUBE_URL}?sub_confirmation=1`).setEmoji('🔔'),
    )],
    allowedMentions: { roles: ping && pingRoleId ? [pingRoleId] : [] },
  };
}

module.exports = { fetchVideos, videoMessage, teaser };
