// a phone gets a path it can use where a computer gets an installer: the phone app in the hero, and on /download the
// desktop link mailed by the account service (or shared), never only a .dmg
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, ...p), 'utf8');
const route = (() => { try { return /DESKTOP_LINK_PATH = "([^"]+)"/.exec(read('..', 'dashboard', 'server', 'email', 'desktop-link.ts'))?.[1]; } catch { return null; } })();

test('the download page sends the desktop link through the account service, with the mail app and share as fallbacks', () => {
  const js = read('public', 'landing', 'pages.js'), page = read('public', 'landing', 'download', 'index.html');
  assert.equal(route, '/api/public/desktop-link');
  assert.ok(js.includes(`fetch('${route}'`), 'pages.js posts to the account route');
  assert.match(js, /mailto:/, 'the mail app is still the fallback');
  assert.match(js, /navigator\.share/);
  assert.match(js, /'desktop_link_email', 'sent'/);
  assert.match(js, /'desktop_link_share'/);
  const panel = /<div class="dl-phone"[\s\S]*?data-dl-share[^>]*>[^<]*<\/button>/.exec(page)?.[0] ?? '';
  assert.match(panel, /<form class="dl-mail" id="dl-mail" data-dl-mail novalidate>/);
  assert.match(panel, /name="website"[^>]*tabindex="-1"/, 'a honeypot for form robots');
  assert.match(panel, /role="status"/);
  assert.match(panel, /<button class="dl-share" type="button" data-dl-share/);
  assert.match(panel, /href="https:\/\/apps\.apple\.com\/[^"]+" data-dl-ios data-dusk-platform="ios"/);
  assert.match(panel, /DuskBot\.apk" data-dl-android data-dusk-platform="android"/);
  assert.doesNotMatch(panel, /\.(dmg|exe|deb|appimage)"/i);
});

test('the hero offers a phone its own app and the link for its computer, not a computer installer', () => {
  const home = read('public', 'landing', 'index.html'), js = read('public', 'landing', 'home.js');
  const phone = [...home.matchAll(/<li data-phone hidden><a href="([^"]+)"[^>]*data-key="([a-z]+)"/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(phone.map(([key]) => key), ['ios', 'android', 'computer']);
  assert.match(phone[0][1], /^https:\/\/apps\.apple\.com\//);
  assert.match(phone[1][1], /\.apk$/);
  assert.equal(phone[2][1], '/download');
  assert.match(js, /if \(key === 'phone'\) \{[\s\S]*?main\.href = app\.href/);
  assert.match(js, /'get the app'/);
});
