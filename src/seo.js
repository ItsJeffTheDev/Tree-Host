'use strict';
// Search engines and AI assistants: page titles, descriptions, keywords, link previews, structured data (JSON-LD),
// robots.txt, sitemap.xml and llms.txt. Used by the real site (server.js) and by the staging build, so both match.

const PAGES = [
  {
    path: '/', file: 'index.html', priority: '1.0', changefreq: 'weekly',
    title: 'Tree Host: Minecraft Server Hosting, Ready in a Minute',
    description: 'Minecraft server hosting for every server type and version: Paper, Purpur, Fabric, Vanilla, Velocity and more. One-click plugins and modpacks, automatic backups, a live console and unlimited servers on every plan.',
    keywords: ['minecraft server hosting', 'minecraft hosting', 'cheap minecraft server', 'paper server hosting', 'fabric server hosting', 'minecraft modpack hosting', 'minecraft smp hosting', 'tree host'],
  },
  {
    path: '/features', file: 'features.html', priority: '0.9', changefreq: 'monthly',
    title: 'Features: Plugins, Modpacks, Backups and More | Tree Host',
    description: 'Everything included with Tree Host Minecraft servers: every server type and version, one-click plugins from Modrinth, Fabric modpacks, backups, a live console, a file manager and isolated resources.',
    keywords: ['minecraft server features', 'one click minecraft plugins', 'minecraft modpack server', 'minecraft server backups', 'minecraft server console', 'modrinth plugins'],
  },
  {
    path: '/why', file: 'why.html', priority: '0.9', changefreq: 'monthly',
    title: 'Why Tree Host: Compare Minecraft Server Hosts and Prices',
    description: 'How Tree Host compares with other Minecraft hosts: pick a plan and see prices side by side. A lifetime plan, unlimited servers per plan, servers that sleep when empty, a crash doctor and one-click proxy networks.',
    keywords: ['best minecraft server hosting', 'minecraft hosting comparison', 'minecraft hosting prices', 'apex hosting alternative', 'shockbyte alternative', 'lifetime minecraft server', 'minecraft realms alternative'],
  },
  {
    path: '/pricing', file: 'pricing.html', priority: '0.9', changefreq: 'weekly',
    title: 'Pricing: Minecraft Server Plans{from} | Tree Host',
    description: 'Simple Minecraft server plans with every feature included and unlimited servers on each plan. Monthly plans or a one-time Lifetime plan. Cancel any time.',
    keywords: ['minecraft server price', 'cheap minecraft server hosting', 'minecraft server plans', 'lifetime minecraft hosting', 'minecraft server monthly'],
  },
  {
    path: '/creators', file: 'creators.html', priority: '0.6', changefreq: 'monthly',
    title: 'Creator Program: Get Paid to Recommend Tree Host',
    description: 'Earn 10-20% of every first payment from players you send to Tree Host. Share your personal link, give viewers a discount code, request a payout any time. No follower minimums.',
    keywords: ['minecraft server affiliate program', 'minecraft creator program', 'get paid to recommend minecraft hosting', 'minecraft referral program', 'tree host creators'],
  },
  {
    path: '/servers', file: 'servers.html', priority: '0.7', changefreq: 'daily',
    title: 'Minecraft Server List | Tree Host',
    description: 'Minecraft servers hosted on Tree Host: survival SMPs, modded worlds, minigames, creative and more. Find one and join.',
    keywords: ['minecraft server list', 'minecraft servers to join', 'minecraft smp servers', 'modded minecraft servers'],
  },
  {
    path: '/support', file: 'support.html', priority: '0.7', changefreq: 'monthly',
    title: 'Support and FAQ | Tree Host',
    description: 'Help with your Tree Host Minecraft server: answers to common questions, step-by-step guides and how to contact the team.',
    keywords: ['minecraft server help', 'minecraft server faq', 'how to join minecraft server', 'minecraft server whitelist', 'install minecraft plugins'],
  },
  {
    path: '/about', file: 'about.html', priority: '0.6', changefreq: 'yearly',
    title: 'About Tree Host',
    description: 'Tree Host is Minecraft server hosting built by Minecraft players to be simple, fair and honest.',
    keywords: ['tree host', 'about tree host', 'minecraft hosting company'],
  },
  {
    path: '/investors', file: 'investors.html', priority: '0.5', changefreq: 'monthly',
    title: 'Invest in Tree Host',
    description: 'The investment case for Tree Host: Minecraft server hosting built on sleep-when-empty economics, so the same machine sells more of its RAM and prices stay structurally lower than 24/7 hosts. Live traction numbers and the $2,000 launch fund.',
    keywords: ['invest in minecraft hosting', 'minecraft hosting startup', 'minecraft hosting investment', 'invest in tree host', 'minecraft hosting company funding'],
  },
  {
    path: '/team', file: 'team.html', priority: '0.5', changefreq: 'monthly',
    title: 'Meet the Team | Tree Host',
    description: 'The people who build and run Tree Host Minecraft server hosting.',
    keywords: ['tree host team', 'tree host owner', 'tree host developers'],
  },
  {
    path: '/donate', file: 'donate.html', priority: '0.6', changefreq: 'weekly',
    title: 'Donate to the Launch Fund | Tree Host',
    description: 'Help Tree Host launch. See every cost of running Tree Host, receipt-style, and how far donations go toward each one.',
    keywords: ['donate tree host', 'minecraft hosting launch fund', 'support minecraft server host'],
  },
  {
    path: '/help.html', file: 'help.html', priority: '0.7', changefreq: 'monthly',
    title: 'Help and Guides | Tree Host',
    description: 'Guides for running a Minecraft server on Tree Host: getting started, plugins, modpacks, worlds, billing and troubleshooting.',
    keywords: ['minecraft server guide', 'how to make a minecraft server', 'minecraft server troubleshooting'],
  },
  { path: '/terms', file: 'terms.html', priority: '0.3', changefreq: 'yearly', title: 'Terms of Service | Tree Host', description: 'The terms for using Tree Host Minecraft server hosting: plans, renewals, refunds, acceptable use and copyright.', keywords: [] },
  { path: '/privacy', file: 'privacy.html', priority: '0.3', changefreq: 'yearly', title: 'Privacy Policy | Tree Host', description: 'What Tree Host collects when you use it, what we do with it, how long we keep it and your rights.', keywords: [] },
  { path: '/dmca', file: 'dmca.html', priority: '0.2', changefreq: 'yearly', title: 'Copyright (DMCA) | Tree Host', description: 'How to report copyright infringement on Tree Host, and how to send a counter-notice.', keywords: [] },
];
const DOCS = [
  ['getting-started', 'Getting started', 'Create an account, pick a plan and get your first Minecraft server running.'],
  ['servers', 'Your server', 'The console, plugins, modpacks, worlds, backups, settings, sharing, sleep, schedules, Bedrock and more.'],
  ['billing', 'Billing', 'How plans, payments, codes and canceling work.'],
  ['troubleshooting', 'Troubleshooting', "Fixes for crashes, out-of-memory errors, can't-connect problems and more."],
];
const pageFor = (p) => PAGES.find((x) => x.path === p) || null;
// A page's address. Static hosts serve /features from features/index.html at /features/ (slash: true).
const addr = (base, p, slash) => `${base}${p}${slash && p !== '/' && !p.endsWith('.html') ? '/' : ''}`;

const escAttr = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escXml = escAttr;
const textOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rarr;/g, '→').replace(/\s+/g, ' ').trim();
const money = (cents) => (cents / 100).toFixed(2);

function organization(base, site) {
  return {
    '@type': 'Organization',
    '@id': `${base}/#organization`,
    name: site.company || 'Tree Host',
    url: `${base}/`,
    logo: `${base}/brand/tree-host-logo-512.png`,
    ...(site.supportEmail ? { email: site.supportEmail } : {}),
    ...(site.discord ? { sameAs: [site.discord] } : {}),
  };
}

/** Plans as schema.org offers (monthly plans bill each month; Lifetime is one payment). */
function offers(base, plans, prelaunch) {
  return (plans.plans || []).map((p) => ({
    '@type': 'Offer',
    name: `${p.name}${p.oneTime ? '' : ` (${+(p.ramMb / 1024).toFixed(1)} GB)`}`,
    description: p.description || undefined,
    price: money(p.priceCents),
    priceCurrency: (plans.currency || 'usd').toUpperCase(),
    url: `${base}/pricing`,
    availability: prelaunch ? 'https://schema.org/PreOrder' : p.soldOut ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
    ...(p.oneTime ? {} : { priceSpecification: { '@type': 'UnitPriceSpecification', price: money(p.priceCents), priceCurrency: (plans.currency || 'usd').toUpperCase(), billingDuration: 'P1M', unitText: 'month' } }),
  }));
}

/** The FAQ on the support page, read from its <details><summary> questions. */
function faqFrom(html) {
  const items = [...html.matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)];
  return items.map(([, q, a]) => ({ '@type': 'Question', name: textOf(q), acceptedAnswer: { '@type': 'Answer', text: textOf(a) } }));
}

/**
 * Puts the SEO tags into a public page's <head>: title, description, keywords, canonical address, link previews
 * (Open Graph, Twitter) and structured data. opts: { base, path, site, plans, prelaunch }.
 */
function injectSeo(html, { base, path, site = {}, plans = {}, prelaunch = false, slash = false }) {
  const page = pageFor(path);
  if (!page || !base) return html;
  const url = addr(base, path, slash);
  // "{from}" in a title becomes the cheapest monthly price, so it's never out of date.
  const monthly = (plans.plans || []).filter((p) => !p.oneTime).map((p) => p.priceCents);
  const from = monthly.length ? ` from $${(Math.min(...monthly) / 100).toFixed(Math.min(...monthly) % 100 ? 2 : 0)}/month` : '';
  const title = page.title.replace('{from}', from);
  const image = `${base}/media/tree-host-tour.jpg`;
  const graph = [
    organization(base, site),
    { '@type': 'WebSite', '@id': `${base}/#website`, url: `${base}/`, name: 'Tree Host', publisher: { '@id': `${base}/#organization` }, inLanguage: 'en' },
    { '@type': 'WebPage', '@id': `${url}#webpage`, url, name: title, description: page.description, isPartOf: { '@id': `${base}/#website` }, inLanguage: 'en' },
  ];
  if ((path === '/pricing' || path === '/') && (plans.plans || []).length) {
    graph.push({
      '@type': 'Product',
      name: 'Tree Host Minecraft server hosting',
      description: 'Minecraft server hosting for every server type and version, with unlimited servers on every plan.',
      brand: { '@id': `${base}/#organization` },
      image,
      offers: offers(base, plans, prelaunch),
    });
  }
  if (path === '/support') {
    const faq = faqFrom(html);
    if (faq.length) graph.push({ '@type': 'FAQPage', mainEntity: faq });
  }
  if (path !== '/') {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Tree Host', item: `${base}/` },
        { '@type': 'ListItem', position: 2, name: title.split(/[:|]/)[0].trim(), item: url },
      ],
    });
  }
  const tags = [
    `<meta name="description" content="${escAttr(page.description)}">`,
    page.keywords.length ? `<meta name="keywords" content="${escAttr(page.keywords.join(', '))}">` : '',
    '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">',
    `<link rel="canonical" href="${escAttr(url)}">`,
    '<meta name="theme-color" content="#0b110d">',
    '<meta property="og:site_name" content="Tree Host">',
    `<meta property="og:type" content="${path === '/' ? 'website' : 'article'}">`,
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(page.description)}">`,
    `<meta property="og:url" content="${escAttr(url)}">`,
    `<meta property="og:image" content="${escAttr(image)}">`,
    '<meta property="og:image:width" content="1280"><meta property="og:image:height" content="800">',
    '<meta property="og:image:alt" content="The Tree Host dashboard running a Minecraft server">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escAttr(title)}">`,
    `<meta name="twitter:description" content="${escAttr(page.description)}">`,
    `<meta name="twitter:image" content="${escAttr(image)}">`,
    `<link rel="alternate" type="text/plain" title="Tree Host for AI assistants" href="${escAttr(base)}/llms.txt">`,
    `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>`,
  ].filter(Boolean);
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`)
    // The page's own description, preview and robots tags are replaced by the full set.
    .replace(/\s*<meta (?:name="(?:description|keywords|robots|theme-color)"|property="og:[^"]+"|name="twitter:[^"]+")[^>]*>/g, '')
    .replace(/\s*<link rel="canonical"[^>]*>/g, '')
    .replace(/<\/head>/, `  ${tags.join('\n  ')}\n</head>`);
}

/** robots.txt: everyone (search engines and AI assistants) may read the public pages; accounts and the API stay out. */
function robotsTxt(base) {
  // /api/ stays open: the public pages load their plans, team and prices from it (private calls need a sign-in anyway).
  const closed = ['/dashboard', '/app', '/admin', '/staff-docs'];
  const ai = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Amazonbot', 'meta-externalagent', 'DuckAssistBot', 'MistralAI-User'];
  const block = (agents) => `${agents.map((a) => `User-agent: ${a}`).join('\n')}\nAllow: /\n${closed.map((p) => `Disallow: ${p}`).join('\n')}\n`;
  return `# Tree Host: search engines and AI assistants are welcome to read and cite the public site.\n\n${block(['*'])}\n# AI assistants and AI search, named so there's no doubt\n${block(ai)}\nSitemap: ${base}/sitemap.xml\n`;
}

function sitemapXml(base, { slash = false, lastmod = new Date().toISOString().slice(0, 10) } = {}) {
  const urls = [
    ...PAGES.map((p) => ({ loc: addr(base, p.path, slash), priority: p.priority, changefreq: p.changefreq })),
    ...DOCS.map(([id]) => ({ loc: `${base}/help.html?doc=${id}`, priority: '0.6', changefreq: 'monthly' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escXml(u.loc)}</loc><lastmod>${lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`;
}

/** llms.txt (llmstxt.org): a short, plain summary of Tree Host for AI assistants, with links to the details. */
function llmsTxt(base, { site = {}, plans = {}, prelaunch = false, slash = false } = {}) {
  const usd = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
  const planLines = (plans.plans || []).map((p) =>
    p.oneTime
      ? `- ${p.name}: ${usd(p.priceCents)} once (no renewals): ${p.slots ? `${p.slots.servers} servers of ${+(p.ramMb / 1024).toFixed(1)} GB, ${p.slots.proxies} proxies` : `${+(p.ramMb / 1024).toFixed(1)} GB`}${p.prioritySupport ? ', priority support' : ''}${p.founding && p.capTotal ? `, first ${p.capTotal} only` : ''}.`
      : `- ${p.name}: ${usd(p.priceCents)}/month: ${+(p.ramMb / 1024).toFixed(1)} GB RAM, ${p.cpus} CPU, ${p.diskGb} GB disk, unlimited servers on the plan.`,
  );
  const link = (p) => `- [${p.title.replace('{from}', '').split(/[:|]/)[0].trim()}](${addr(base, p.path, slash)}): ${p.description}`;
  return `# Tree Host

> Tree Host is Minecraft server hosting for every server type and version (Paper, Purpur, Folia, Spigot, CraftBukkit, Fabric, Vanilla, Velocity, Waterfall, BungeeCord). Every plan runs unlimited servers, each with the plan's full memory, and includes one-click plugins and Fabric modpacks from Modrinth, backups, a live console, a file manager, Bedrock crossplay, servers that sleep when empty and wake when someone joins, scheduled tasks and a crash doctor.
${prelaunch ? '\nTree Host has not launched yet: this is a preview of the website. Accounts, the dashboard and servers open at launch.\n' : ''}
## Plans (USD)

${planLines.join('\n') || '- See the pricing page.'}

Prices on the pricing page are the source of truth. Monthly plans renew until canceled; cancel any time in Billing.

## Pages

${PAGES.filter((p) => p.priority >= '0.5').map(link).join('\n')}

## Guides (plain text)

${DOCS.map(([id, t, d]) => `- [${t}](${base}/docs/${id}.md): ${d}`).join('\n')}

## Contact

- Support: ${site.supportEmail || 'see the support page'}
${site.discord ? `- Discord: ${site.discord}\n` : ''}
## Optional

${PAGES.filter((p) => p.priority < '0.5').map(link).join('\n')}
`;
}

module.exports = { PAGES, DOCS, pageFor, injectSeo, robotsTxt, sitemapXml, llmsTxt };
