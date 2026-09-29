'use strict';
// Honey Host Help: renders the Markdown guides in public/docs with search, an "On this page" menu,
// callouts (> **Tip:** / **Note:** / **Important:** / **Warning:**), copyable code and previous/next links.

const DOCS = [
  { id: 'getting-started', title: 'Getting started', icon: '👋', group: 'Start here' },
  { id: 'servers', title: 'Servers and plugins', icon: '🧱', group: 'Using Honey Host' },
  { id: 'roles', title: 'Roles & permissions', icon: '🔑', group: 'Using Honey Host' },
  { id: 'admin-guide', title: 'Admin guide', icon: '🛠', group: 'For admins' },
  { id: 'troubleshooting', title: 'Troubleshooting', icon: '🩹', group: 'Help' },
];

const $ = (sel, el = document) => el.querySelector(sel);
const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

// ---------- Markdown ----------

function inline(text) {
  const codes = [];
  let s = escHtml(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const m = /^([\w-]+)\.md(#.*)?$/.exec(href);
      if (m) return `<a href="?doc=${m[1]}${m[2] || ''}">${label}</a>`;
      if (href.startsWith('#')) return `<a href="${href}">${label}</a>`;
      return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
    });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function codeBlock(code) {
  return `<div class="code-wrap"><button class="btn sm copy-btn" type="button">Copy</button><pre><code>${escHtml(code)}</code></pre></div>`;
}

function callout(text) {
  const html = inline(text);
  const m = /^<b>(Tip|Note|Important|Warning):<\/b>\s*/i.exec(html);
  const label = m ? m[1] : 'Note';
  const kind = /tip/i.test(label) ? 'tip' : /important|warning/i.test(label) ? 'warn' : 'note';
  const body = m ? html.slice(m[0].length) : html;
  return `<div class="callout ${kind}"><p><span class="c-label">${label}:</span> ${body}</p></div>`;
}

function table(rows) {
  const cells = (r) =>
    r
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  const align = cells(rows[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : ''));
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const cls = (i) => (align[i] ? ` class="${align[i]}"` : '');
  return `<div class="table-wrap"><table><thead><tr>${head.map((h, i) => `<th${cls(i)}>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${inline(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

function render(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{1,4} |```|> |\||---\s*$|\s*([-*]|\d+\.) )/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    if (line.startsWith('```')) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      out.push(codeBlock(code.join('\n')));
    } else if ((m = /^(#{1,4}) (.*)$/.exec(line))) {
      const level = m[1].length;
      const id = slugify(m[2]);
      const anchor = level === 2 || level === 3 ? `<a class="anchor" href="#${id}">#</a>` : '';
      out.push(`<h${level} id="${id}">${inline(m[2])}${anchor}</h${level}>`);
      i++;
    } else if (/^---\s*$/.test(line)) {
      out.push('<hr>');
      i++;
    } else if (line.startsWith('> ') || line === '>') {
      const quote = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) quote.push(lines[i++].replace(/^> ?/, ''));
      out.push(callout(quote.join(' ')));
    } else if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      out.push(table(rows));
    } else if ((m = /^(\s*)([-*]|\d+\.) /.exec(line))) {
      const ordered = /\d/.test(m[2]);
      const items = [];
      let sawBlank = false;
      while (i < lines.length) {
        const l = lines[i];
        const im = /^\s*([-*]|\d+\.) (.*)$/.exec(l);
        if (im && /^\s{0,1}\S/.test(l)) {
          items.push({ text: [im[2]], blocks: [] });
          sawBlank = false;
          i++;
        } else if (
          l.trim() &&
          /^\s{2,}/.test(l) &&
          items.length &&
          !sawBlank &&
          !items[items.length - 1].blocks.length &&
          !/^\s*([-*]|\d+\.) |^\s*```|^\s*> |^\s*\|/.test(l)
        ) {
          items[items.length - 1].text.push(l.trim());
          i++;
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          const block = [];
          while (i < lines.length && (lines[i].trim() === '' || /^\s{2,}/.test(lines[i]))) {
            if (lines[i].trim() === '' && !(lines[i + 1] && /^\s{2,}/.test(lines[i + 1]))) break;
            block.push(lines[i].replace(/^ {1,3}/, ''));
            i++;
          }
          items[items.length - 1].blocks.push(render(block.join('\n')));
        } else if (!l.trim() && lines[i + 1] && (/^\s*([-*]|\d+\.) /.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) {
          sawBlank = true;
          i++;
        } else if (l.trim() && !isBlockStart(l) && items.length) {
          items[items.length - 1].text.push(l.trim());
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it.text.join(' '))}${it.blocks.join('')}</li>`).join('')}</${tag}>`);
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

// ---------- loading ----------

const cache = new Map();
async function loadDoc(id) {
  if (!cache.has(id)) {
    cache.set(
      id,
      fetch(`docs/${id}.md`, { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.text();
      }),
    );
  }
  return cache.get(id);
}

function currentId() {
  const id = new URLSearchParams(location.search).get('doc');
  return DOCS.some((d) => d.id === id) ? id : DOCS[0].id;
}

// ---------- navigation ----------

function renderNav(active) {
  let html = '';
  let group = null;
  for (const d of DOCS) {
    if (d.group !== group) {
      group = d.group;
      html += `<div class="nav-group">${group}</div>`;
    }
    html += `<a class="doc ${d.id === active ? 'active' : ''}" href="?doc=${d.id}"><span class="ico">${d.icon}</span>${d.title}</a>`;
  }
  $('#nav-links').innerHTML = html;
}

function renderPager(active) {
  const i = DOCS.findIndex((d) => d.id === active);
  const prev = DOCS[i - 1];
  const next = DOCS[i + 1];
  $('#pager').innerHTML =
    (prev ? `<a class="prev" href="?doc=${prev.id}"><div class="p-label">← Previous</div><div class="p-title">${prev.icon} ${prev.title}</div></a>` : '') +
    (next ? `<a class="next" href="?doc=${next.id}"><div class="p-label">Next →</div><div class="p-title">${next.icon} ${next.title}</div></a>` : '');
}

function renderToc() {
  const heads = [...document.querySelectorAll('#doc h2')];
  const toc = $('#toc');
  if (heads.length < 2) {
    toc.innerHTML = '';
    return;
  }
  toc.innerHTML =
    '<div class="toc-title">On this page</div>' +
    heads.map((h) => `<a href="#${h.id}" data-for="${h.id}">${h.firstChild.textContent}</a>`).join('');
  const links = [...toc.querySelectorAll('a')];
  const spy = () => {
    let current = heads[0];
    for (const h of heads) if (h.getBoundingClientRect().top < 120) current = h;
    links.forEach((a) => a.classList.toggle('on', a.dataset.for === current.id));
  };
  window.onscroll = spy;
  spy();
}

async function show() {
  const id = currentId();
  const meta = DOCS.find((d) => d.id === id);
  renderNav(id);
  renderPager(id);
  const el = $('#doc');
  try {
    el.innerHTML = render(await loadDoc(id));
  } catch (e) {
    el.textContent = `Could not load this guide: ${e.message}`;
    return;
  }
  // The first paragraph under the title is the page's intro.
  const h1 = el.querySelector('h1');
  if (h1 && h1.nextElementSibling && h1.nextElementSibling.tagName === 'P') h1.nextElementSibling.classList.add('lead');
  el.querySelectorAll('.copy-btn').forEach((b) =>
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.nextElementSibling.textContent).then(() => {
        b.textContent = 'Copied!';
        setTimeout(() => (b.textContent = 'Copy'), 1500);
      });
    }),
  );
  document.title = `${meta.title} · Honey Host Help`;
  renderToc();
  if (location.hash) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) target.scrollIntoView();
  } else window.scrollTo(0, 0);
}

// ---------- search ----------

async function buildIndex() {
  const entries = [];
  for (const d of DOCS) {
    let md;
    try {
      md = await loadDoc(d.id);
    } catch {
      continue;
    }
    let anchor = '';
    let heading = d.title;
    for (const raw of md.split('\n')) {
      const h = /^(#{1,4}) (.*)$/.exec(raw);
      if (h) {
        heading = h[2];
        anchor = h[1].length > 1 ? slugify(h[2]) : '';
        entries.push({ doc: d, anchor, heading, text: h[2] });
        continue;
      }
      const text = raw
        .replace(/^[>\s|*-]+|\|/g, ' ')
        .replace(/^\d+\.\s/, '')
        .replace(/[`*]/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .trim();
      if (text.length > 3 && !/^:?-+:?$/.test(text)) entries.push({ doc: d, anchor, heading, text });
    }
  }
  return entries;
}

let indexPromise = null;
function setupSearch() {
  const q = $('#q');
  const box = $('#results');
  q.addEventListener('input', async () => {
    const term = q.value.trim().toLowerCase();
    if (term.length < 2) {
      box.classList.remove('show');
      box.innerHTML = '';
      return;
    }
    indexPromise = indexPromise || buildIndex();
    const index = await indexPromise;
    const seen = new Set();
    const hits = [];
    for (const e of index) {
      if (!e.text.toLowerCase().includes(term)) continue;
      const key = `${e.doc.id}#${e.anchor}#${e.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(e);
      if (hits.length >= 12) break;
    }
    const mark = (t) => {
      const i = t.toLowerCase().indexOf(term);
      const start = Math.max(0, i - 40);
      const snippet = (start ? '…' : '') + t.slice(start, i + term.length + 60) + (i + term.length + 60 < t.length ? '…' : '');
      return escHtml(snippet).replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), (m) => `<mark>${m}</mark>`);
    };
    box.classList.add('show');
    box.innerHTML = hits.length
      ? hits
          .map(
            (h) => `<a href="?doc=${h.doc.id}${h.anchor ? `#${h.anchor}` : ''}"><span class="r-doc">${h.doc.icon} ${escHtml(h.doc.title)}${
              h.heading !== h.doc.title ? ` › ${escHtml(h.heading.replace(/[`*]/g, ''))}` : ''
            }</span><span class="r-text">${mark(h.text)}</span></a>`,
          )
          .join('')
      : '<div class="none">No matches.</div>';
  });
}

setupSearch();
show();
