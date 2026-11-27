// the sitemaps and robots.txt. /sitemap.xml is an index of: core.xml (the site's own pages), hubs.xml (the seo hubs) and
// one file per seo cohort, so search console can report how each release is indexed. lastmod is the day a page's main
// content last changed, kept in seo/lastmod.json by content hash (never the build date: google only trusts a lastmod that
// is consistently right). priority and changefreq are left out; google ignores them.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { seoDir } from './records.mjs';
import { localDay } from './quality.mjs';

const ledgerFile = path.join(seoDir, 'lastmod.json');
// what counts as a change: the page's main content without asset version stamps, or the record for seo pages
const keyOf = (k) => createHash('sha256').update(String(k).includes('<main') ? (/<main[\s\S]*<\/main>/.exec(k)?.[0] || k).replace(/\?v=[0-9a-f]{8}/g, '') : String(k)).digest('hex').slice(0, 16);

export function writeSitemaps({ site, SITE_URL, built, cohorts, today = localDay(), persist = true }) {
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {};
  const next = {};
  for (const p of built.filter((b) => b.index)) {
    const hash = keyOf(p.lastmodKey), was = ledger[p.address];
    next[p.address] = was && was.hash === hash ? was : { hash, lastmod: today };
  }
  // a variant build (the waitlist home) reads the ledger but leaves it as the main build wrote it
  if (persist) fs.writeFileSync(ledgerFile, JSON.stringify(next, null, 1) + '\n');
  const dir = path.join(site, 'sitemaps');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const groups = new Map();
  for (const p of built.filter((b) => b.index)) { const g = p.group || 'core'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  const order = ['core', 'hubs', ...cohorts.map((c) => c.id)];
  for (const g of groups.keys()) if (!order.includes(g)) throw new Error(`a page is in sitemap group ${g}, which is not a cohort in seo/release.json`);
  const files = [];
  // a sitemap holds at most 50,000 addresses; files are cut at 40,000 to stay well inside that and the 50 mb limit
  const SHARD = 40000;
  for (const g of order.filter((x) => groups.has(x))) for (let i = 0, all = groups.get(g).sort((a, b) => a.address.localeCompare(b.address)); i < all.length; i += SHARD) {
    const list = all.slice(i, i + SHARD);
    const name = (g === 'core' || g === 'hubs' ? g : `cohort-${g}`) + (i ? `-${i / SHARD + 1}` : '');
    fs.writeFileSync(path.join(dir, `${name}.xml`), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${list.map((p) => `  <url><loc>${SITE_URL}${p.address}</loc><lastmod>${next[p.address].lastmod}</lastmod></url>`).join('\n')}\n</urlset>\n`);
    files.push([name, list.reduce((m, p) => (next[p.address].lastmod > m ? next[p.address].lastmod : m), '')]);
  }
  fs.writeFileSync(path.join(site, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${files.map(([name, lastmod]) => `  <sitemap><loc>${SITE_URL}/sitemaps/${name}.xml</loc><lastmod>${lastmod}</lastmod></sitemap>`).join('\n')}\n</sitemapindex>\n`);
  return files.map(([name]) => name);
}

// search engines, the ai search and answer crawlers and the ai model crawlers are all welcome; the app demo and the
// design boards are not pages
export const SEARCH_BOTS = ['Googlebot', 'Bingbot', 'YandexBot', 'DuckDuckBot', 'Applebot', 'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Perplexity-User', 'Claude-SearchBot', 'Claude-User',
  'GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended'];
export function robotsTxt(SITE_URL) {
  const keepOut = 'Disallow: /explore/\nDisallow: /api/\n';
  return `${SEARCH_BOTS.map((b) => `User-agent: ${b}\nAllow: /\n${keepOut}`).join('\n')}\nUser-agent: *\nAllow: /\n${keepOut}\nSitemap: ${SITE_URL}/sitemap.xml\n`;
}

// /llms.txt (llmstxt.org): what dusk bot is and its main pages, docs and guides, for ai assistants reading the site.
// pages are { address, title, description, group }; the seo cohort pages stay in the sitemaps only
export function llmsTxt(SITE_URL, pages) {
  const line = (p) => `- [${p.title}](${SITE_URL}${p.address === '/' ? '/' : p.address})${p.description ? `: ${p.description}` : ''}`;
  const by = (f) => pages.filter(f).sort((a, b) => a.address.localeCompare(b.address)).map(line);
  const sections = [
    ['pages', by((p) => p.group === 'core' && !p.address.startsWith('/docs'))],
    ['docs', by((p) => p.group === 'core' && p.address.startsWith('/docs'))],
    ['guides', by((p) => p.group === 'hubs')],
  ].filter(([, l]) => l.length);
  return `# dusk bot\n\n> Your own team of AI bots, in a chat app, on the AI accounts you already have. Free on your computer for personal use, and on dusk cloud they keep working with your laptop off.\n\n${sections.map(([h, l]) => `## ${h}\n\n${l.join('\n')}\n`).join('\n')}`;
}
