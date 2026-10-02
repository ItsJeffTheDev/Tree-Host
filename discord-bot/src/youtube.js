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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TreeHostBot/1.0', 'Accept-Language': 'en' };

/** Videos from one of YouTube's feeds (newest first). */
async function fromFeed(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const link = attr(e, 'link', 'href');
    return {
      id: tag(e, 'yt:videoId'),
      title: tag(e, 'title'),
      url: link,
      short: link.includes('/shorts/'),
      published: tag(e, 'published'),
      description: tag(e, 'media:description'),
      views: Number(attr(e, 'media:statistics', 'views')) || 0,
    };
  });
}

/** Last resort: the channel's Videos and Shorts pages (ids and titles; no description). */
async function fromChannelPages(channelId) {
  const out = [];
  for (const [tab, short] of [['videos', false], ['shorts', true]]) {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}/${tab}`, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!res.ok) continue;
    const html = await res.text();
    const seen = new Set(out.map((v) => v.id));
    const str = (s) => {
      try {
        return JSON.parse(`"${s}"`);
      } catch {
        return s;
      }
    };
    // Each video is a "lockupViewModel" (Videos tab) or "shortsLockupViewModel" (Shorts tab) block; older pages
    // use "videoRenderer" / "reelItemRenderer".
    const blocks = html.split(/"(?:lockupViewModel|shortsLockupViewModel|videoRenderer|reelItemRenderer|gridVideoRenderer)":\{/).slice(1);
    for (const b of blocks.map((x) => x.slice(0, 6000))) {
      const id = (/"(?:contentId|videoId)":"([A-Za-z0-9_-]{11})"/.exec(b) || [])[1];
      const title = (/"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/.exec(b)
        || /"overlayMetadata":\{"primaryText":\{"content":"((?:[^"\\]|\\.)*)"/.exec(b)
        || /"(?:title|headline)":\{(?:"runs":\[\{"text":|"simpleText":)"((?:[^"\\]|\\.)*)"/.exec(b) || [])[1];
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: str(title), url: short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`, short, published: '', description: '', views: 0 });
    }
  }
  if (!out.length) throw new Error('no videos found on the channel pages');
  return out;
}

/**
 * Newest first: [{ id, title, url, short, published, description, views }].
 * YouTube's feed often answers 404/500 for a while, so: retry, then the uploads-playlist feed, then the channel pages.
 */
async function fetchVideos(channelId) {
  const errors = [];
  const tries = [
    () => fromFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`),
    () => fromFeed(`https://www.youtube.com/feeds/videos.xml?playlist_id=UU${channelId.slice(2)}`),
    () => fromFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`),
    () => fromChannelPages(channelId),
  ];
  for (const [i, attempt] of tries.entries()) {
    try {
      return await attempt();
    } catch (e) {
      errors.push(e.message);
      if (i < tries.length - 1) await sleep(2000 * (i + 1));
    }
  }
  throw Object.assign(new Error(`YouTube is not answering right now (${[...new Set(errors)].join(', ')})`), { youtubeDown: true });
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
