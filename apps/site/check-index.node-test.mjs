import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { problems, unlistedSitemaps, trackingLink, MIN_WORDS } from './check-index.mjs';

const at = 'https://dusk.bot/integrations/gmail';
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const page = ({ head = `<link rel="canonical" href="${at}">`, main = `<p>${words(MIN_WORDS + 10)}</p>` } = {}) => `<!doctype html><html><head>${head}</head><body><main>${main}</main></body></html>`;
const ok = (body, headers = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body });

test('a real page passes', () => {
  assert.deepEqual(problems(at, ok(page())), []);
});

test('noindex in a meta tag or a header fails', () => {
  assert.match(problems(at, ok(page({ head: `<meta name="robots" content="noindex"><link rel="canonical" href="${at}">` })))[0], /meta robots/);
  assert.match(problems(at, ok(page(), { 'x-robots-tag': 'noindex, nofollow' }))[0], /X-Robots-Tag/);
});

test('a redirect, a 404 or a 410 fails', () => {
  assert.match(problems(at, { status: 308, headers: { location: '/integrations' }, body: '' })[0], /answers 308 \(to \/integrations\)/);
  assert.match(problems(at, { status: 404, headers: {}, body: '' })[0], /answers 404/);
  assert.match(problems(at, { status: 410, headers: {}, body: '' })[0], /answers 410/);
});

test('a missing or foreign canonical fails', () => {
  assert.match(problems(at, ok(page({ head: '' })))[0], /no canonical/);
  assert.match(problems(at, ok(page({ head: '<link rel="canonical" href="https://dusk.bot/">' })))[0], /canonical is https:\/\/dusk\.bot\//);
});

test('a thin page or an empty state fails', () => {
  assert.match(problems(at, ok(page({ main: '<h1>join</h1><form><input></form>' })))[0], /thin/);
  const empty = page({ main: `<h2>nothing to report yet.</h2><p>${words(MIN_WORDS)}</p>` });
  assert.match(problems(at, ok(empty)).join(), /reads as empty/);
});

test('script and svg text does not count toward the words', () => {
  assert.match(problems(at, ok(page({ main: `<script>${words(500)}</script><svg>${words(500)}</svg><p>hi</p>` })))[0], /thin/);
});

test('a child sitemap on disk that the index does not list is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemaps-'));
  for (const f of ['core.xml', 'cohort-01.xml', 'cohort-02.xml']) fs.writeFileSync(path.join(dir, f), '');
  const index = '<sitemapindex><sitemap><loc>https://dusk.bot/sitemaps/core.xml</loc></sitemap><sitemap><loc>https://dusk.bot/sitemaps/cohort-01.xml</loc></sitemap></sitemapindex>';
  assert.deepEqual(unlistedSitemaps(dir, index), ['cohort-02.xml']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an internal link with a tracking query is caught, a plain or asset one is not', () => {
  for (const bad of ['/?source=seo:/guides/grok-tasks', '/?ref=producthunt', '/waitlist?source=download', '/download?plan=pro&amp;utm_source=x']) assert.ok(trackingLink(bad), bad);
  for (const ok of ['/', '/download', '/site.css?v=46e9899c', '/dashboard/signup?plan=pro', '#source=x', 'https://x.com/?ref=a']) assert.ok(!trackingLink(ok), ok);
});
