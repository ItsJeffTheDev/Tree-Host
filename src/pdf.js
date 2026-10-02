'use strict';
// A small PDF writer (no dependencies) for staff reports: flowing text with wrapping and page breaks, headings,
// label/value tables, monospaced logs, JPEG images, and a header and footer on every page.
// Text uses the standard PDF fonts (Helvetica, Helvetica-Bold, Courier) with WinAnsi encoding.
const zlib = require('zlib');

// Glyph widths (per 1000 units) for characters 32..126.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const FONTS = { regular: 'F1', bold: 'F2', mono: 'F3' };

// Characters outside Latin-1 that WinAnsi still has.
const WIN_ANSI = { 0x20ac: 0x80, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99, 0x2192: 0x3e };

/** A string as WinAnsi byte codes (emoji and other unsupported characters are dropped or replaced). */
function toCodes(str) {
  const out = [];
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0);
    if (c === 9) out.push(32, 32, 32, 32);
    else if (c >= 32 && c <= 126) out.push(c);
    else if (c >= 160 && c <= 255) out.push(c);
    else if (WIN_ANSI[c]) out.push(WIN_ANSI[c]);
    else if (c === 0x2713 || c === 0x2714) out.push(0x76); // check marks become "v"
    else if (c > 0xffff || (c >= 0x2600 && c <= 0x27bf) || c === 0xfe0f || c === 0x200d) continue; // emoji
    else if (c >= 32) out.push(0x3f);
  }
  return out;
}

function charWidth(code, font) {
  if (font === 'mono') return 600;
  const table = font === 'bold' ? HELV_BOLD : HELV;
  if (code >= 32 && code <= 126) return table[code - 32];
  if (code === 0x95) return 350;
  if (code === 0x97) return 1000;
  return 556;
}

const textWidth = (codes, font, size) => (codes.reduce((w, c) => w + charWidth(c, font), 0) * size) / 1000;

/** A PDF string literal from byte codes. */
function pdfString(codes) {
  let s = '(';
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += `\\${String.fromCharCode(c)}`;
    else if (c < 32 || c > 126) s += `\\${c.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(c);
  }
  return `${s})`;
}

/** Splits text into lines that fit `width` (long words are broken). Keeps blank lines. */
function wrap(text, font, size, width) {
  const lines = [];
  for (const para of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const words = para.split(/(\s+)/).filter((w) => w !== '');
    let line = [];
    let lineW = 0;
    const push = () => {
      lines.push(line);
      line = [];
      lineW = 0;
    };
    for (const word of words) {
      let codes = toCodes(word);
      const isSpace = /^\s+$/.test(word);
      if (isSpace && !line.length) continue;
      let w = textWidth(codes, font, size);
      if (lineW + w <= width) {
        line.push(...codes);
        lineW += w;
        continue;
      }
      if (isSpace) {
        push();
        continue;
      }
      if (line.length) {
        while (line.length && line[line.length - 1] === 32) line.pop();
        push();
      }
      // A word longer than a whole line: break it.
      while (w > width) {
        let n = codes.length;
        while (n > 1 && textWidth(codes.slice(0, n), font, size) > width) n--;
        lines.push(codes.slice(0, n));
        codes = codes.slice(n);
        w = textWidth(codes, font, size);
      }
      line = [...codes];
      lineW = w;
    }
    while (line.length && line[line.length - 1] === 32) line.pop();
    lines.push(line);
  }
  return lines;
}

/** Width, height and color space of a JPEG, or null if it isn't one. */
function jpegInfo(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const comps = buf[i + 9];
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), colorSpace: comps === 1 ? 'DeviceGray' : comps === 4 ? 'DeviceCMYK' : 'DeviceRGB' };
    }
    i += 2 + len;
  }
  return null;
}

const rgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(' ');
};

class PdfDoc {
  /**
   * opts: { title, subtitle, accent ('#2fb36d'), footer (text on every page), header (small text on pages 2+) }
   */
  constructor(opts = {}) {
    this.W = 612;
    this.H = 792;
    this.M = 50;
    this.opts = { accent: '#2fb36d', ...opts };
    this.pages = [];
    this.images = [];
    this.addPage(true);
  }

  get contentWidth() {
    return this.W - this.M * 2;
  }

  addPage(first = false) {
    this.page = { ops: [] };
    this.pages.push(this.page);
    if (first && this.opts.title) {
      // Title band
      this.rect(0, this.H - 110, this.W, 110, this.opts.accent);
      this.textAt(this.opts.kicker || '', this.M, this.H - 40, { font: 'bold', size: 10, color: '#e9fff2' });
      this.textAt(this.opts.title, this.M, this.H - 68, { font: 'bold', size: 24, color: '#ffffff' });
      if (this.opts.subtitle) this.textAt(this.opts.subtitle, this.M, this.H - 90, { size: 11, color: '#e9fff2' });
      this.y = this.H - 140;
    } else {
      if (this.opts.header) this.textAt(this.opts.header, this.M, this.H - 32, { size: 8.5, color: '#7a8590' });
      this.line(this.M, this.H - 40, this.W - this.M, this.H - 40, '#d5dbe1');
      this.y = this.H - 64;
    }
  }

  /** Starts a new page if fewer than `h` points are left above the footer. */
  ensure(h) {
    if (this.y - h < 60) this.addPage();
  }

  // ----- drawing primitives (PDF coordinates: origin bottom-left) -----

  rect(x, y, w, h, fill, stroke) {
    if (fill) this.page.ops.push(`${rgb(fill)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    if (stroke) this.page.ops.push(`${rgb(stroke)} RG 0.75 w ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
  }

  line(x1, y1, x2, y2, color = '#d5dbe1', width = 0.75) {
    this.page.ops.push(`${rgb(color)} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  textAt(text, x, y, { font = 'regular', size = 10.5, color = '#1d2329' } = {}) {
    const codes = Array.isArray(text) ? text : toCodes(text);
    if (!codes.length) return;
    this.page.ops.push(`BT /${FONTS[font]} ${size} Tf ${rgb(color)} rg ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(codes)} Tj ET`);
  }

  // ----- flowing content -----

  space(h = 8) {
    this.y -= h;
  }

  /** Wrapped paragraph. */
  para(text, { font = 'regular', size = 10.5, color = '#1d2329', indent = 0, gap = 1.35, width } = {}) {
    const lh = size * gap;
    for (const line of wrap(text, font, size, (width || this.contentWidth) - indent)) {
      this.ensure(lh);
      this.y -= lh;
      this.textAt(line, this.M + indent, this.y + size * 0.25, { font, size, color });
    }
  }

  /** Section heading with a rule under it. */
  heading(text) {
    this.ensure(48);
    this.y -= 22;
    this.textAt(text, this.M, this.y, { font: 'bold', size: 13.5, color: '#14191e' });
    this.y -= 7;
    this.line(this.M, this.y, this.W - this.M, this.y, this.opts.accent, 1.2);
    this.y -= 6;
  }

  subheading(text) {
    this.ensure(30);
    this.y -= 16;
    this.textAt(text, this.M, this.y, { font: 'bold', size: 11, color: '#14191e' });
    this.y -= 4;
  }

  /** Label/value rows; values wrap in their own column. */
  table(rows, { labelWidth = 140, size = 10 } = {}) {
    const lh = size * 1.4;
    for (const [label, value] of rows) {
      if (value === undefined || value === null || value === '') continue;
      const lines = wrap(String(value), 'regular', size, this.contentWidth - labelWidth);
      this.ensure(Math.min(lines.length, 3) * lh + 6);
      const top = this.y;
      this.textAt(label, this.M, top - lh + size * 0.25, { font: 'bold', size, color: '#5b6670' });
      lines.forEach((l, i) => {
        if (i && this.y - lh < 60) {
          this.addPage();
        }
        this.y -= lh;
        this.textAt(l, this.M + labelWidth, this.y + size * 0.25, { size });
      });
      if (!lines.length) this.y -= lh;
      this.y -= 3;
      this.line(this.M, this.y, this.W - this.M, this.y, '#edf0f3', 0.5);
    }
  }

  /** A shaded box with wrapped text (for messages and quotes). */
  box(text, { title, fill = '#f3f6f8', border = '#d5dbe1', size = 10.5 } = {}) {
    const pad = 10;
    const lines = wrap(text || '(nothing written)', 'regular', size, this.contentWidth - pad * 2);
    const lh = size * 1.4;
    let i = 0;
    while (i < lines.length || i === 0) {
      const titleH = i === 0 && title ? 16 : 0;
      const room = Math.max(1, Math.floor((this.y - 60 - pad * 2 - titleH) / lh));
      if (room < 2 && lines.length - i > 1) {
        this.addPage();
        continue;
      }
      const chunk = lines.slice(i, i + room);
      const h = chunk.length * lh + pad * 2 + titleH;
      this.rect(this.M, this.y - h, this.contentWidth, h, fill, border);
      let y = this.y - pad;
      if (titleH) {
        this.textAt(title, this.M + pad, y - 9, { font: 'bold', size: 9, color: '#5b6670' });
        y -= titleH;
      }
      for (const l of chunk) {
        y -= lh;
        this.textAt(l, this.M + pad, y + size * 0.3, { size });
      }
      this.y -= h + 6;
      i += chunk.length;
      if (i < lines.length) this.addPage();
      if (!lines.length) break;
    }
  }

  /** Monospaced block (logs), shaded, split across pages as needed. */
  mono(text, { size = 7.5 } = {}) {
    const lh = size * 1.32;
    const lines = wrap(text, 'mono', size, this.contentWidth - 12);
    let i = 0;
    while (i < lines.length) {
      const room = Math.floor((this.y - 66) / lh);
      if (room < 3) {
        this.addPage();
        continue;
      }
      const chunk = lines.slice(i, i + room);
      const h = chunk.length * lh + 10;
      this.rect(this.M, this.y - h, this.contentWidth, h, '#f6f8fa', '#e1e6eb');
      let y = this.y - 5;
      for (const l of chunk) {
        y -= lh;
        this.textAt(l, this.M + 6, y + size * 0.28, { font: 'mono', size, color: '#26313b' });
      }
      this.y -= h + 6;
      i += chunk.length;
    }
  }

  /** A JPEG image scaled to fit the page width (and at most `maxH` tall). Returns false if it isn't a JPEG. */
  image(buf, { maxH = 420, caption } = {}) {
    const info = jpegInfo(buf);
    if (!info) return false;
    const scale = Math.min(this.contentWidth / info.width, maxH / info.height, 1);
    const w = info.width * scale;
    const h = info.height * scale;
    this.ensure(h + (caption ? 18 : 6));
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, buf, ...info });
    this.page.images = [...(this.page.images || []), name];
    this.y -= h;
    this.rect(this.M - 0.5, this.y - 0.5, w + 1, h + 1, null, '#d5dbe1');
    this.page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${this.M.toFixed(2)} ${this.y.toFixed(2)} cm /${name} Do Q`);
    if (caption) {
      this.y -= 12;
      this.textAt(caption, this.M, this.y, { size: 8.5, color: '#7a8590' });
    }
    this.y -= 8;
    return true;
  }

  /** The finished PDF as a Buffer. */
  toBuffer() {
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      this.page = p;
      this.line(this.M, 44, this.W - this.M, 44, '#d5dbe1');
      if (this.opts.footer) this.textAt(this.opts.footer, this.M, 30, { size: 8, color: '#7a8590' });
      const label = `Page ${i + 1} of ${total}`;
      this.textAt(label, this.W - this.M - textWidth(toCodes(label), 'regular', 8), 30, { size: 8, color: '#7a8590' });
    });

    const objects = []; // [id] = Buffer|string
    const add = (body) => objects.push(body) && objects.length;
    const catalogId = add(null);
    const pagesId = add(null);
    const fontIds = {
      F1: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
      F2: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
      F3: add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
    };
    const imageIds = {};
    for (const im of this.images) {
      const head = `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /${im.colorSpace} /BitsPerComponent 8 /Filter /DCTDecode${im.colorSpace === 'DeviceCMYK' ? ' /Decode [1 0 1 0 1 0 1 0]' : ''} /Length ${im.buf.length} >>\nstream\n`;
      imageIds[im.name] = add(Buffer.concat([Buffer.from(head, 'latin1'), im.buf, Buffer.from('\nendstream', 'latin1')]));
    }
    const fontRes = Object.entries(fontIds).map(([k, id]) => `/${k} ${id} 0 R`).join(' ');
    const pageIds = [];
    for (const p of this.pages) {
      const content = zlib.deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'));
      const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]));
      const xobj = (p.images || []).map((n) => `/${n} ${imageIds[n]} 0 R`).join(' ');
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << ${fontRes} >>${xobj ? ` /XObject << ${xobj} >>` : ''} >> /Contents ${contentId} 0 R >>`));
    }
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    const infoId = add(`<< /Title ${pdfString(toCodes(this.opts.docTitle || this.opts.title || 'Report'))} /Producer (Tree Host) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);

    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    objects.forEach((body, i) => {
      const buf = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
      offsets.push(offset);
      offset += buf.length;
      chunks.push(buf);
    });
    const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}

module.exports = { PdfDoc, jpegInfo };
