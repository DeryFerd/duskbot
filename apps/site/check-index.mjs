// every address in the sitemaps must be a page google can index: answered 200 with no redirect, no noindex (meta robots
// or X-Robots-Tag), a canonical that is the address itself, and real text on it, not an empty state that reads as a soft
// 404. zero deps.
//   node check-index.mjs                       # serves the built site (public/landing) with server.js and checks it
//   node check-index.mjs --url https://dusk.bot  # checks a live site the same way
// exits 1 and lists each address with what is wrong.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE_URL = 'https://dusk.bot';
// below this many words in <main> a page reads as thin; the shortest real pages (contact, the glossary hub) are ~140
export const MIN_WORDS = 120;
// what an empty or missing page says; google files a page that says it as a soft 404
const EMPTY = /nothing to report|nothing here yet|coming soon|page (?:is )?not found|this page is not here|no results|needs javascript/i;
const UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
export function mainText(html) {
  const main = /<main[\s\S]*<\/main>/i.exec(html)?.[0] || '';
  return main.replace(/<(script|style|svg|template|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[#a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function problems(address, { status, headers, body }) {
  const out = [];
  if (status !== 200) out.push(`answers ${status}${headers.location ? ` (to ${headers.location})` : ''}`);
  if (/noindex|none/i.test(headers['x-robots-tag'] || '')) out.push(`X-Robots-Tag: ${headers['x-robots-tag']}`);
  if (status !== 200) return out;
  if (!/^text\/html/i.test(headers['content-type'] || '')) out.push(`is ${headers['content-type'] || 'no content type'}, not html`);
  const head = /<head[\s\S]*?<\/head>/i.exec(body)?.[0] || '';
  for (const m of head.matchAll(/<meta[^>]+name=["']?(?:robots|googlebot)["']?[^>]*>/gi)) if (/content=["'][^"']*(?:noindex|none)/i.test(m[0])) out.push(`meta robots: ${m[0]}`);
  const canonical = /<link[^>]+rel=["']?canonical["']?[^>]*>/i.exec(head)?.[0];
  const href = canonical && /href=["']([^"']+)/i.exec(canonical)?.[1];
  if (!href) out.push('no canonical link');
  else if (href !== address) out.push(`canonical is ${href}`);
  const words = mainText(body).split(' ').filter(Boolean).length;
  if (words < MIN_WORDS) out.push(`thin: ${words} words in <main> (needs ${MIN_WORDS})`);
  const empty = EMPTY.exec(mainText(body));
  if (empty) out.push(`reads as empty: "${empty[0]}"`);
  return out;
}

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-encoding': 'identity' }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
}

// an internal link whose address carries a tracking query (?source=, ?ref=, utm_) is one more crawlable copy of its page;
// who sent someone rides on a data attribute instead (seo/templates.mjs ctaLink)
export const trackingLink = (href) => /^\/[^?#]*\?(?:[^#]*&)?(?:source|ref|utm_[a-z]+)=/i.test(String(href).replace(/&amp;/g, '&'));

// every child sitemap on disk is in the index, so none is left unchecked (and unseen by search engines)
export function unlistedSitemaps(dir, indexXml) {
  const listed = new Set(locs(indexXml).map((u) => u.split('/').pop()));
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.xml') && !listed.has(f)) : [];
}

export async function checkSite(base, { concurrency = 8, sitemapDir = null } = {}) {
  const bad = new Map(), note = (k, why) => bad.set(k, [...(bad.get(k) || []), why]);
  const index = await get(`${base}/sitemap.xml`);
  if (index.status !== 200) { note('/sitemap.xml', `answers ${index.status}`); return { bad, count: 0 }; }
  const maps = /<sitemapindex/.test(index.body) ? locs(index.body) : [];
  if (sitemapDir) for (const f of unlistedSitemaps(sitemapDir, index.body)) note(`/sitemaps/${f}`, 'is not listed in /sitemap.xml');
  const addresses = maps.length ? [] : locs(index.body);
  for (const m of maps) {
    if (!m.startsWith(`${SITE_URL}/`)) { note(m, `sitemap is not on ${SITE_URL}`); continue; }
    const r = await get(base + m.slice(SITE_URL.length));
    if (r.status !== 200) { note(m, `answers ${r.status}`); continue; }
    addresses.push(...locs(r.body));
  }
  const seen = new Set();
  for (const a of addresses) { if (seen.has(a)) note(a, 'listed twice'); seen.add(a); }
  const list = [...seen];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < list.length) {
      const address = list[next++];
      if (address !== SITE_URL + '/' && !address.startsWith(`${SITE_URL}/`)) { note(address, `not on ${SITE_URL}`); continue; }
      try { for (const why of problems(address, await get(base + (address.slice(SITE_URL.length) || '/')))) note(address, why); } catch (err) { note(address, `fetch failed: ${err.message}`); }
    }
  }));
  return { bad, count: list.length };
}

async function serveBuild() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dusk-check-index-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), DUSK_WAITLIST_FILE: path.join(tmp, 'waitlist.jsonl') };
  for (const k of ['DUSK_HOME_ONLY', 'DUSK_NO_INDEX', 'MONGODB_URI', 'BREVO_API_KEY']) delete env[k];
  const child = spawn(process.execPath, [path.join(here, 'server.js'), 'landing'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const stop = () => { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); };
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) { stop(); throw new Error(`server.js exited: ${log.trim()}`); }
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return { base: `http://127.0.0.1:${port}`, stop }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  throw new Error(`server.js did not start: ${log.trim()}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--url');
  const live = at > 0 ? process.argv[at + 1]?.replace(/\/+$/, '') : null;
  const served = live ? null : await serveBuild();
  try {
    const { bad, count } = await checkSite(live || served.base, { sitemapDir: live ? null : path.join(here, 'public', 'landing', 'sitemaps') });
    if (bad.size) {
      for (const [address, why] of bad) console.log(`problem: ${address}: ${why.join('; ')}`);
      console.log(`${bad.size} of ${count} sitemap addresses cannot be indexed`);
      process.exitCode = 1;
    } else console.log(`all ${count} sitemap addresses answer 200, are indexable and have real text`);
  } finally { served?.stop(); }
}
