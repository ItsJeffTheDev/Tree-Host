'use strict';
// MOTDs (the message under a server's name in Minecraft's server list), written with & codes:
// &0-&9 &a-&f colors, &l bold, &o italic, &n underline, &m strikethrough, &k obfuscated, &r reset, and &#RRGGBB hex
// colors (Minecraft 1.16+ on Paper/Spigot). Each server type gets the format it understands.

const COLORS = {
  0: '000000', 1: '0000AA', 2: '00AA00', 3: '00AAAA', 4: 'AA0000', 5: 'AA00AA', 6: 'FFAA00', 7: 'AAAAAA',
  8: '555555', 9: '5555FF', a: '55FF55', b: '55FFFF', c: 'FF5555', d: 'FF55FF', e: 'FFFF55', f: 'FFFFFF',
};
const MINI = {
  0: 'black', 1: 'dark_blue', 2: 'dark_green', 3: 'dark_aqua', 4: 'dark_red', 5: 'dark_purple', 6: 'gold', 7: 'gray',
  8: 'dark_gray', 9: 'blue', a: 'green', b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white',
  k: 'obfuscated', l: 'bold', m: 'strikethrough', n: 'underlined', o: 'italic',
};
const MAX_LINE = 120; // raw characters per line (codes included)
const MAX_VISIBLE = 60; // what fits in the server list, roughly

const clean = (s) => String(s || '').replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').replace(/§/g, '&');

/** Visible text (codes removed). */
const visible = (s) => clean(s).replace(/&#[0-9a-fA-F]{6}/g, '').replace(/&[0-9a-fk-orA-FK-OR]/g, '');

/** "&6Hi &#ff8800there" -> section codes, with hex as §x§f§f§8§8§0§0 (Spigot/Paper 1.16+). */
function toSection(s) {
  return clean(s)
    .replace(/&#([0-9a-fA-F]{6})/g, (m, h) => `§x${h.toLowerCase().split('').map((c) => `§${c}`).join('')}`)
    .replace(/&([0-9a-fk-orA-FK-OR])/g, (m, c) => `§${c.toLowerCase()}`);
}

/** Like toSection, but hex colors become the nearest of the 16 classic colors (for Vanilla and older servers). */
function toClassic(s) {
  const near = (hex) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    let best = 'f';
    let dist = Infinity;
    for (const [code, h] of Object.entries(COLORS)) {
      const [R, G, B] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
      if (d < dist) [best, dist] = [code, d];
    }
    return best;
  };
  return toSection(clean(s).replace(/&#([0-9a-fA-F]{6})/g, (m, h) => `&${near(h)}`));
}

/** Velocity speaks MiniMessage: <gold><bold>Hi</bold> ... */
function toMiniMessage(s) {
  let out = '';
  const parts = clean(s).split(/(&#[0-9a-fA-F]{6}|&[0-9a-fk-orA-FK-OR])/);
  for (const part of parts) {
    if (/^&#/.test(part)) out += `<reset><#${part.slice(2).toLowerCase()}>`;
    else if (/^&[0-9a-fA-F]$/.test(part)) out += `<reset><${MINI[part[1].toLowerCase()]}>`;
    else if (/^&[k-oK-O]$/.test(part)) out += `<${MINI[part[1].toLowerCase()]}>`;
    else if (/^&[rR]$/.test(part)) out += '<reset>';
    else out += part.replace(/</g, '\\<').replace(/\n/g, '<newline>');
  }
  return out;
}

/** A value for server.properties (Java properties: non-ASCII as \uXXXX, newlines as \n). */
function propertiesValue(s) {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Checks and tidies what the owner typed: up to 2 lines per frame, up to 10 frames. */
function normalize(input) {
  const frames = (Array.isArray(input.frames) && input.frames.length ? input.frames : [input.text || ''])
    .slice(0, 10)
    .map((f) => clean(f).split('\n').slice(0, 2).map((l) => l.replace(/\s+$/, '')).join('\n'));
  for (const f of frames) {
    for (const line of f.split('\n')) {
      if (line.length > MAX_LINE) throw Object.assign(new Error(`A line is too long (${line.length} characters with codes, ${MAX_LINE} at most).`), { status: 400 });
    }
  }
  if (!frames[0] || !visible(frames[0]).trim()) throw Object.assign(new Error('Write a message.'), { status: 400 });
  const interval = Math.max(1, Math.min(60, Math.round(Number(input.interval) || 3)));
  return { frames, interval, animated: frames.length > 1 };
}

module.exports = { toSection, toClassic, toMiniMessage, propertiesValue, normalize, visible, MAX_VISIBLE };
