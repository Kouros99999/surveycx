// Builds the public site for search engines and people without JavaScript.
//
//   node web/build-site.js <site dir>     the directory GitHub Pages will publish (a copy of web/ plus the demo pages)
//
// What it does to that directory, in place:
//   - renders every help-center article to a static page kb/<slug>.html with its own title, description, canonical URL and JSON-LD
//   - pre-renders the article list into kb.html and the release notes into releases.html (the JS stays for hash scrolling)
//   - fills the landing page's "latest version" line and adds Organization, SoftwareApplication and FAQ JSON-LD
//   - adds canonical, Open Graph and Twitter tags to every page, and writes sitemap.xml and robots.txt
// Needs `marked` (npm install --no-save marked@12) next to node or on NODE_PATH.
'use strict';
const fs = require('fs'), path = require('path');
const { marked } = require('marked');

const ORIGIN = 'https://surveycx.ai';
const out = path.resolve(process.argv[2] || 'site');
const read = (f) => fs.readFileSync(path.join(out, f), 'utf8').replace(/\r\n/g, '\n');   // CRLF checkouts must match the same strings
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true }); fs.writeFileSync(path.join(out, f), s); };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

const kb = JSON.parse(read('kb/index.json'));
const releases = JSON.parse(read('releases.json'));
const latest = releases[0];

// ---------- shared chrome for generated article pages (one level down, hence ../) ----------
const header = (up) => `<header class="site"><div class="wrap">
  <a class="mark" href="${up}./"><img src="${up}logo.svg" alt="">SurveyCX for Amazon Connect</a>
  <button class="menu-btn" aria-label="Menu" onclick="document.querySelector('nav.main').classList.toggle('open')">Menu</button>
  <nav class="main"><a href="${up}index.html#features">Features</a><a href="${up}index.html#pricing">Pricing</a><a href="${up}kb.html">Help</a><a href="${up}releases.html">Release notes</a><a href="${up}support.html">Support</a><a class="cta" href="${up}agent-panel.html">See the demo</a></nav>
</div></header>`;
const footer = (up) => `<footer class="site"><div class="wrap">
  <div><a class="mark" href="${up}./"><img src="${up}logo.svg" alt="">SurveyCX</a><p style="margin-top:.6rem">Post-contact surveys for Amazon Connect and other contact-centre platforms, by EKPK LLC.</p></div>
  <div><h4>Product</h4><a href="${up}index.html#features">Features</a><a href="${up}index.html#pricing">Pricing</a><a href="${up}agent-panel.html">Demo</a><a href="${up}releases.html">Release notes</a></div>
  <div><h4>Support</h4><a href="${up}kb.html">Help center</a><a href="${up}support.html">Contact support</a><a href="${up}kb/security-and-data.html">Security</a><a href="${up}privacy.html">Privacy policy</a><a href="https://github.com/Kouros99999/surveycx">Documentation on GitHub</a></div>
  <div class="legal">Amazon Connect is a trademark of Amazon.com, Inc. or its affiliates. SurveyCX is not affiliated with or endorsed by Amazon. © EKPK LLC.</div>
</div></footer>`;

/** Canonical, Open Graph and Twitter tags for a page, from its own title and description. */
function social(html, urlPath, image) {
  if (/rel="canonical"/.test(html)) return html;
  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || 'SurveyCX for Amazon Connect';
  const desc = (/<meta name="description" content="([^"]*)"/.exec(html) || [])[1] || '';
  const tags = `<link rel="canonical" href="${ORIGIN}${urlPath}">
<meta property="og:type" content="website"><meta property="og:site_name" content="SurveyCX for Amazon Connect"><meta property="og:url" content="${ORIGIN}${urlPath}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${ORIGIN}/${image || 'img/og.png'}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${ORIGIN}/${image || 'img/og.png'}">
<meta name="theme-color" content="#0F766E">
`;
  return html.replace(/(<link rel="icon" type="image\/svg\+xml"[^>]*>)/, tags + '$1');
}

// ---------- help-center articles as static pages ----------
marked.use({ gfm: true, breaks: false });
const urls = [];
for (const a of kb) {
  const md = read('kb/' + a.slug + '.md');
  let body = marked.parse(md);
  // Links written for the JS reader: kb.html?a=slug -> slug.html (same folder); other site pages -> one level up.
  body = body.replace(/href="kb\.html\?a=([a-z0-9-]+)"/g, 'href="$1.html"').replace(/href="(index|releases|support|privacy|kb)\.html/g, 'href="../$1.html').replace(/href="(agent-panel|supervisor-console|wallboard|report)\.html/g, 'href="../$1.html');
  body = body.replace(/<a href="http/g, '<a target="_blank" rel="noopener" href="http');
  const ld = { '@context': 'https://schema.org', '@type': 'TechArticle', headline: a.title, description: a.summary, url: `${ORIGIN}/kb/${a.slug}.html`, author: { '@type': 'Organization', name: 'EKPK LLC' }, publisher: { '@type': 'Organization', name: 'EKPK LLC' }, about: 'SurveyCX for Amazon Connect', version: a.updated, isPartOf: { '@type': 'WebSite', name: 'SurveyCX for Amazon Connect', url: ORIGIN } };
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Help center', item: `${ORIGIN}/kb.html` }, { '@type': 'ListItem', position: 2, name: a.title, item: `${ORIGIN}/kb/${a.slug}.html` }] };
  const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.title)} · SurveyCX Help Center</title>
<meta name="description" content="${esc(a.summary)}">
<link rel="icon" type="image/svg+xml" href="../logo.svg">
<link rel="stylesheet" href="../site.css?v=1">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<script type="application/ld+json">${JSON.stringify(crumbs)}</script>
<style>article h1{margin-top:.6rem}article h2{margin-top:1.8rem}article code{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:.05rem .35rem;font-size:.92em}article pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:.8rem 1rem;overflow-x:auto;font-size:.9rem}article pre code{border:0;background:transparent;padding:0}article table{min-width:0}article .upd{color:var(--muted);font-size:.85rem}.crumb{font-size:.9rem;color:var(--muted);margin-top:1.2rem}.crumb a{color:var(--muted)}.related{margin-top:2rem;border-top:1px solid var(--line);padding-top:1rem}.related a{display:block;margin:.3rem 0}</style>
${header('../')}
<main class="page">
  <p class="crumb"><a href="../kb.html">Help center</a> › ${esc(a.title)}</p>
  <article>${body}<p class="upd">Current as of version ${esc(a.updated)}. See the <a href="../releases.html">release notes</a> for what changed since.</p></article>
  <div class="related"><h2>More in the help center</h2>${kb.filter((b) => b.slug !== a.slug).slice(0, 6).map((b) => `<a href="${b.slug}.html">${esc(b.title)}</a>`).join('')}</div>
</main>
${footer('../')}
</html>
`;
  write('kb/' + a.slug + '.html', social(page, `/kb/${a.slug}.html`));
  urls.push({ loc: `/kb/${a.slug}.html`, changefreq: 'monthly', priority: '0.7' });
}

// ---------- kb.html: pre-rendered list; a ?a= link lands on the static page ----------
{
  let html = read('kb.html');
  const list = kb.map((a) => `<li><a href="kb/${a.slug}.html">${esc(a.title)}</a><p>${esc(a.summary)}</p><small>Current as of version ${esc(a.updated)}</small></li>`).join('');
  html = html.replace('<main class="page" id="main">\n  <p class="muted">Loading…</p>\n</main>',
    `<main class="page" id="main">
  <h1>Help center</h1><p class="lede">Guides for setting up and running SurveyCX. Each article says which version it is current for; the <a href="releases.html">release notes</a> list what changed.</p>
  <input class="search" id="q" type="search" placeholder="Search the help center" aria-label="Search the help center"><ul class="kb-list" id="list">${list}</ul>
  <p class="muted">Can't find it? Email <a href="mailto:support@surveycx.ai">support@surveycx.ai</a>.</p>
</main>`);
  // Replace the loader with a redirect for old ?a= links and a search filter over the rendered list.
  html = html.replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/marked[^]*<\/script>\s*<script>[^]*?<\/script>/, `<script>
(function () {
  const slug = new URLSearchParams(location.search).get('a');
  if (slug && /^[a-z0-9-]+$/.test(slug)) { location.replace('kb/' + slug + '.html'); return; }
  const items = [...document.querySelectorAll('#list li')];
  document.getElementById('q').addEventListener('input', (e) => { const q = e.target.value.trim().toLowerCase(); items.forEach((li) => { li.hidden = !!q && !li.textContent.toLowerCase().includes(q); }); });
})();
</script>`);
  write('kb.html', social(html, '/kb.html'));
}

// ---------- releases.html: pre-rendered sections ----------
{
  let html = read('releases.html');
  const sections = releases.map((r, i) => `<section class="rel" id="v${esc(r.version)}">
      <h2>Version ${esc(r.version)}${i === 0 ? ' <span class="tag">Latest</span>' : ''}</h2>
      <p class="muted">${day(r.date)}</p>
      <p><b>${esc(r.title)}.</b> ${esc(r.summary)}</p>
      <ul>${r.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      ${r.upgrade && r.upgrade.length ? `<h3>If you are upgrading</h3><ul>${r.upgrade.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    </section>`).join('');
  html = html.replace('<div id="releases"><p class="muted">Loading release notes…</p></div>', `<div id="releases">${sections}</div>`)
    .replace(/<noscript>[^]*?<\/noscript>\s*/, '')
    .replace(/<script>\n\(async function \(\) \{[^]*?\}\)\(\);\n<\/script>/, `<script>if (location.hash) { const el = document.getElementById(location.hash.slice(1)); if (el) el.scrollIntoView(); }</script>`);
  const ld = { '@context': 'https://schema.org', '@type': 'ItemList', name: 'SurveyCX for Amazon Connect release notes', itemListElement: releases.map((r, i) => ({ '@type': 'ListItem', position: i + 1, name: `Version ${r.version}: ${r.title}`, url: `${ORIGIN}/releases.html#v${r.version}` })) };
  html = html.replace('</title>', `</title>\n<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
  write('releases.html', social(html, '/releases.html'));
}

// ---------- index.html: latest line, JSON-LD, social ----------
{
  let html = read('index.html');
  html = html.replace('<span id="latest"></span>', `<span id="latest">Latest version ${esc(latest.version)}, ${day(latest.date)}: <a href="releases.html#v${esc(latest.version)}">${esc(latest.title)}</a>.</span>`);
  const faq = [...html.matchAll(/<details><summary>([^<]*)<\/summary><p>([^]*?)<\/p><\/details>/g)].map((m) => ({ '@type': 'Question', name: m[1], acceptedAnswer: { '@type': 'Answer', text: m[2].replace(/<[^>]+>/g, '') } }));
  const price = (/\$(\d+\.\d+) <small>per completed response/.exec(html) || [])[1] || '0.10';
  const ld = [
    { '@context': 'https://schema.org', '@type': 'Organization', name: 'EKPK LLC', url: ORIGIN, logo: `${ORIGIN}/logo.png`, email: 'support@surveycx.ai' },
    { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'SurveyCX for Amazon Connect', applicationCategory: 'BusinessApplication', operatingSystem: 'Web', url: ORIGIN, softwareVersion: latest.version, description: (/<meta name="description" content="([^"]*)"/.exec(html) || [])[1],
      offers: { '@type': 'Offer', price, priceCurrency: 'USD', description: 'Per completed survey response, billed through AWS Marketplace. 30-day free trial for up to 500 responses a day.', url: `${ORIGIN}/#pricing` }, publisher: { '@type': 'Organization', name: 'EKPK LLC' }, screenshot: `${ORIGIN}/img/results.png` },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq },
  ];
  html = html.replace('<title>SurveyCX for Amazon Connect</title>', '<title>SurveyCX for Amazon Connect: post-contact surveys on the IVR, in chat, by SMS and email, with results by agent and queue</title>');
  html = html.replace('</title>', '</title>\n' + ld.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n'));
  write('index.html', social(html, '/'));
}
for (const f of ['support.html', 'privacy.html']) write(f, social(read(f), '/' + f));

// ---------- releases.xml: an Atom feed partners and customers can subscribe to ----------
{
  const entries = releases.map((r) => `  <entry>
    <title>SurveyCX ${esc(r.version)}: ${esc(r.title)}</title>
    <link href="${ORIGIN}/releases.html#v${esc(r.version)}"/>
    <id>${ORIGIN}/releases.html#v${esc(r.version)}</id>
    <updated>${r.date}T12:00:00Z</updated>
    <summary>${esc(r.summary)}</summary>
    <content type="html">${esc(`<p>${esc(r.summary)}</p><ul>${r.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>${r.upgrade && r.upgrade.length ? `<h3>If you are upgrading</h3><ul>${r.upgrade.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}`)}</content>
  </entry>`).join('\n');
  write('releases.xml', `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>SurveyCX release notes</title>
  <link href="${ORIGIN}/releases.html"/>
  <link rel="self" href="${ORIGIN}/releases.xml"/>
  <id>${ORIGIN}/releases.xml</id>
  <updated>${latest.date}T12:00:00Z</updated>
  <author><name>EKPK LLC</name></author>
${entries}
</feed>
`);
}

// ---------- sitemap and robots ----------
const today = new Date().toISOString().slice(0, 10);
const pages = [{ loc: '/', priority: '1.0', changefreq: 'weekly' }, { loc: '/kb.html', priority: '0.8', changefreq: 'weekly' }, { loc: '/releases.html', priority: '0.8', changefreq: 'weekly' }, { loc: '/support.html', priority: '0.5', changefreq: 'monthly' }, { loc: '/privacy.html', priority: '0.3', changefreq: 'yearly' }].concat(urls);
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${ORIGIN}${p.loc}</loc><lastmod>${today}</lastmod><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`).join('\n')}\n</urlset>\n`);
write('robots.txt', `User-agent: *\nAllow: /\nDisallow: /agent-panel.html\nDisallow: /supervisor-console.html\nDisallow: /wallboard.html\nDisallow: /report.html\nSitemap: ${ORIGIN}/sitemap.xml\n`);
console.log(`built ${kb.length} articles, ${releases.length} releases, sitemap with ${pages.length} URLs into ${out}`);
