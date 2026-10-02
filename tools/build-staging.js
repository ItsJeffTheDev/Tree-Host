#!/usr/bin/env node
'use strict';
// Builds the staging website: only the public pages (home, menu and footer pages, legal pages, guides), as plain files
// ready for Wasmer Edge (or any static host). No dashboard, no accounts, no servers.
//
//   node tools/build-staging.js [--url https://treehost.online] [--from http://localhost:8766] [--out staging] [--discord ...]
//
// --url is the address the staging site is published at (for search engines: canonical links, sitemap, llms.txt).
//
// The pages' data (plans, team, costs, price comparison) is copied from a running Tree Host (--from, default: the
// test site from Start.bat), so start it first. Deploy with:  cd staging && wasmer deploy
const fs = require('fs');
const path = require('path');
const seo = require('../src/seo');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, a, i, all) => (a.startsWith('--') ? [...out, [a.slice(2), all[i + 1]]] : out), []),
);
const FROM = (args.from || 'http://localhost:8766').replace(/\/$/, '');
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.resolve(ROOT, args.out || 'staging');
const SITE = path.join(OUT, 'public');
// Donations go through the existing Stripe payment link while the site is a preview.
const DONATE_URL = args['donate-url'] || 'https://buy.stripe.com/00wcN7cfK3Jh9lEgEf0oM00';
const DISCORD_DEFAULT = 'https://discord.gg/a37pbwajKd';
const BASE = (args.url || 'https://treehost.online').replace(/\/$/, '');
if (!/^https:\/\/[a-z0-9.-]+$/i.test(BASE)) {
  console.error('--url must be the site address, like https://treehost.online');
  process.exit(1);
}

// Clean URL -> page file. These are every page in the menu and the footer (plus the home page).
const PAGES = {
  '': 'index.html',
  features: 'features.html',
  why: 'why.html',
  servers: 'servers.html',
  pricing: 'pricing.html',
  support: 'support.html',
  about: 'about.html',
  team: 'team.html',
  donate: 'donate.html',
  terms: 'terms.html',
  privacy: 'privacy.html',
  dmca: 'dmca.html',
};
// Files linked as-is (the guides use relative paths, so they stay at the top level).
const EXTRA_PAGES = ['help.html', '404.html'];
const ASSETS = ['site.css', 'site.js', 'icons.js', 'icons.svg', 'help.js', 'style.css', 'brand', 'media', 'docs'];

async function get(p) {
  const r = await fetch(FROM + p).catch(() => null);
  if (!r || !r.ok) throw new Error(`Could not read ${FROM}${p}. Start Tree Host first (Start.bat), or pass --from <address>.`);
  return r.json();
}

function write(rel, data) {
  const file = path.join(SITE, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
}

(async () => {
  console.log(`Reading the public data from ${FROM} ...`);
  const [site, plans, compare, team, donations, servers] = await Promise.all([
    get('/api/site'), get('/api/plans'), get('/api/compare'), get('/api/team-page'), get('/api/donations'), get('/api/public/servers'),
  ]);
  const discord = args.discord || site.discord || DISCORD_DEFAULT;

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(SITE, { recursive: true });

  // ----- data the pages fetch, saved as files at the same addresses -----
  const preview = { mode: 'off' }; // nothing can be bought on the preview
  write('api/site', { ...site, discord, allowSignup: true });
  write('api/plans', { ...plans, ...preview, plans: plans.plans.map((p) => ({ ...p, soldOut: false })) });
  write('api/compare', { ...compare, ...preview, plans: compare.plans.map((p) => ({ ...p, soldOut: false })) });
  write('api/team-page', team);
  write('api/donations', { ...donations, ...preview, fallbackUrl: DONATE_URL });
  write('api/public/servers', { ...servers, servers: [] });
  write('api/auth/me', { user: null });

  // ----- pages: /features is features/index.html, so clean addresses work on any static host -----
  const banner = `<script>window.TH_STAGING_DISCORD = ${JSON.stringify(discord)};</script>\n  <script src="/staging.js" defer></script>\n</body>`;
  // Search engines and AI assistants may index the preview (every page says clearly that it's a preview).
  const seoSite = { company: site.company, supportEmail: site.supportEmail, discord };
  const prep = (html, pagePath) =>
    seo
      .injectSeo(html, { base: BASE, path: pagePath, site: seoSite, plans, prelaunch: true, slash: true })
      .replace(/<html lang="en">/, '<html lang="en" data-staging="1">')
      .replace(/<\/body>/, banner);
  for (const [slug, file] of Object.entries(PAGES)) {
    const html = prep(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), slug ? `/${slug}` : '/');
    write(slug ? `${slug}/index.html` : 'index.html', html);
  }
  for (const file of EXTRA_PAGES) {
    let html = prep(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), `/${file}`);
    if (file === '404.html') html = html.replace('</head>', '  <meta name="robots" content="noindex">\n</head>');
    write(file, html);
  }

  for (const a of ASSETS) fs.cpSync(path.join(PUBLIC, a), path.join(SITE, a), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'staging', 'staging.js'), path.join(SITE, 'staging.js'));
  write('robots.txt', seo.robotsTxt(BASE));
  write('sitemap.xml', seo.sitemapXml(BASE, { slash: true }));
  write('llms.txt', seo.llmsTxt(BASE, { site: seoSite, plans, prelaunch: true, slash: true }));

  // Every local file a page points at must be there.
  const missing = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.html')) {
        for (const [, ref] of fs.readFileSync(p, 'utf8').matchAll(/(?:src|href)="(\/[^"#?]*)/g)) {
          const rel = ref.replace(/^\//, '');
          const target = path.join(SITE, rel);
          if (!rel || fs.existsSync(target) || fs.existsSync(path.join(target, 'index.html'))) continue;
          if (/^(dashboard|app|admin|staff-docs)\b/.test(rel)) continue; // these show the "opens at launch" message
          missing.add(ref);
        }
      }
    }
  };
  walk(SITE);

  // ----- Wasmer Edge (Static Web Server) -----
  fs.writeFileSync(path.join(OUT, 'Staticfile'), 'root: public\n');
  fs.mkdirSync(path.join(OUT, 'settings'), { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'settings', 'config.toml'),
    `[general]
host = "::"
port = 8080
root = "/public"
log-level = "error"
cache-control-headers = true
compression = true
page404 = "./404.html"
directory-listing = false
redirect-trailing-slash = true
security-headers = true
`,
  );
  fs.writeFileSync(
    path.join(OUT, 'README.md'),
    `# Tree Host staging site

The public pages only, as a preview: every page shows a "Staging site" banner, and Sign in, Get started and the
dashboard explain that they open at launch. Built by \`node tools/build-staging.js\` (or Build-Staging.bat) on
${new Date().toISOString().slice(0, 10)} from ${FROM}. Don't edit these files: change the real pages in \`public/\` and
build again.

## Deploy to Wasmer Edge

    wasmer login
    cd staging
    wasmer deploy

Try it on your PC first with \`wasmer run . --net\` and open http://localhost:8080.
`,
  );

  const count = Object.keys(PAGES).length + EXTRA_PAGES.length;
  console.log(`Built ${count} pages in ${path.relative(ROOT, OUT) || OUT}${path.sep}`);
  console.log(`  Data copied: ${plans.plans.length} plans, ${team.members.length} team member(s), ${donations.costs.items.length} costs, ${compare.competitors.hosts.length} hosts to compare.`);
  if (missing.size) console.log(`  Warning, these files are linked but missing: ${[...missing].join(', ')}`);
  console.log(`  Search: canonical links, sitemap and llms.txt use ${BASE} (change it with --url).`);
  console.log('  Deploy: cd staging && wasmer deploy');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
