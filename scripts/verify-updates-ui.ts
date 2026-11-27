// Settings > Updates on the desktop and the phone, What's new, and Android's newer-APK line, photographed with a headless
// Chrome in a throwaway profile against a disposable fake-engine server (update answers faked in the page).
// Run: node --experimental-strip-types scripts/verify-updates-ui.ts <dir> [suffix] [only-regex]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer } from "./control-dusk.ts";
import { openHeadlessChrome, type HeadlessPage } from "./testing/headless-chrome.ts";
import { fixtureApi, mountPreview } from "./testing/preview-fixture.ts";

const shots = resolve(process.argv[2] ?? "updates-ui-shots");
const suffix = process.argv[3] ? `-${process.argv[3]}` : "";
const only = process.argv[4] ? new RegExp(process.argv[4]) : null;

const button = (name: string) => `[...document.querySelectorAll("button")].find((el) => el.textContent.trim().toLowerCase().startsWith(${JSON.stringify(name.toLowerCase())}))`;
const clickText = (name: string) => `(() => { const el = ${button(name)}; if (!el) throw new Error("no button ${name}"); el.click(); })()`;
const openYou = `document.querySelector('[aria-label^="you and settings" i]').click()`;
const scrollEnd = `(() => { for (const el of document.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== "visible") el.scrollTop = el.scrollHeight; })()`;

interface Shot { name: string; phone?: boolean; query: string; steps?: string[]; ready?: string; wait?: number }
const SHOTS: Shot[] = [
  { name: "01-desktop-settings-current", query: "app=current&server=desktop", ready: "[data-settings-open='app-update']" },
  { name: "02-desktop-settings-downloading", query: "app=downloading&server=desktop", ready: "[data-settings-open='app-update']" },
  { name: "18-desktop-remote-client-ready", query: "app=remote-ready&server=newer", wait: 2500 },
  { name: "19-desktop-place-ready", query: "app=place-ready&server=newer", wait: 2500 },
  { name: "20-desktop-place-current", query: "app=place&server=newer", wait: 2500 },
  { name: "04-desktop-settings-no-changelog", query: "app=current&server=desktop&changelog=0", ready: "[data-settings-open='app-update']" },
  { name: "05-desktop-whats-new", query: "app=current&server=desktop", ready: "[data-settings-open='whats-new']", steps: [`document.querySelector("[data-settings-open='whats-new']").click()`], wait: 900 },
  { name: "06-desktop-after-update-line", query: "updated=0.2.31&from=0.2.30&server=desktop", wait: 2500 },
  { name: "07-phone-settings", phone: true, query: "os=android&v=1.2.9&feed=behind&server=behind", steps: [openYou, scrollEnd], wait: 1500 },
  { name: "08-phone-updates-behind", phone: true, query: "os=android&v=1.2.9&feed=behind&server=behind", steps: [openYou, scrollEnd, clickText("Check for updates")], wait: 2500 },
  { name: "09-phone-updates-current", phone: true, query: "os=android&v=1.2.12&feed=current&server=current", steps: [openYou, scrollEnd, clickText("Check for updates")], wait: 2500 },
  { name: "10-phone-updates-iphone", phone: true, query: "os=ios&v=1.2.12&feed=current&server=managed", steps: [openYou, scrollEnd, clickText("Check for updates")], wait: 2500 },
  { name: "11-phone-whats-new", phone: true, query: "os=android&v=1.2.12&feed=current&server=current", steps: [openYou, scrollEnd, clickText("What's new")], wait: 2000 },
  { name: "12-phone-whats-new-no-changelog", phone: true, query: "os=android&v=1.2.12&feed=current&server=current&changelog=0", steps: [openYou, scrollEnd, clickText("What's new")], wait: 2000 },
  { name: "13-phone-home-apk-behind", phone: true, query: "os=android&v=1.2.9&feed=behind&server=current", wait: 7000 },
  { name: "14-phone-home-apk-current", phone: true, query: "os=android&v=1.2.12&feed=current&server=current", wait: 3000 },
  { name: "15-phone-home-feed-missing", phone: true, query: "os=android&v=1.2.9&feed=missing&server=current", wait: 3000 },
  { name: "17-phone-home-app-too-old", phone: true, query: "os=android&v=1.2.12&feed=current&server=current&old=1", wait: 7000 },
  { name: "16-phone-after-update-line", phone: true, query: "os=android&v=1.2.12&last=1.2.9&feed=current&server=current", wait: 3000 },
];

async function shoot(page: HeadlessPage, url: string, shot: Shot, file: string, dark: boolean) {
  await page.send("Emulation.setDeviceMetricsOverride", shot.phone ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1100, height: 760, deviceScaleFactor: 2, mobile: false });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await page.send("Page.navigate", { url: "about:blank" });
  await page.send("Page.navigate", { url });
  await delay(1000);
  await page.evaluate(`(() => { const keep = ${JSON.stringify(shot.phone ? { "dusk.mobile.introSeen": "1" } : {})}; localStorage.clear(); for (const [k, v] of Object.entries(keep)) localStorage.setItem(k, v); })()`);
  await page.send("Page.navigate", { url });
  if (shot.phone) {
    await page.until(`Boolean(document.querySelector('[aria-label^="you and settings" i]'))`, 60_000);
    await delay(1200);
    await page.evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((el) => el.textContent.trim().toLowerCase() === "allow"); b?.click(); })()`);
    await delay(600);
  } else {
    await page.until(`Boolean(document.querySelector('[data-preview-ready]'))`, 60_000);
    await delay(1200);
  }
  for (const step of shot.steps ?? []) { await page.evaluate(step); await delay(1300); }
  if (shot.ready) await page.until(`Boolean(document.querySelector(${JSON.stringify(shot.ready)}))`, 20_000);
  await delay(shot.wait ?? 900);
  writeFileSync(file, await page.capture());
}

const fixture = await launchVerificationServer();
const closers: Array<() => Promise<void>> = [];
try {
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  for (const name of ["Nova", "Quill", "Rivet"]) await api("POST", "/api/bots", { name }).catch(() => {});
  const desk = await mountPreview(fixture, { entry: "/scripts/testing/updates-ui-preview.tsx", route: "/__updates.html", title: "Updates", logLevel: "warn" });
  closers.push(desk.close);
  const phone = await mountPreview(fixture, { entry: "/scripts/testing/updates-ui-phone.tsx", route: "/__updates-phone.html", title: "dusk bot", logLevel: "warn",
    viewport: "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" });
  closers.push(phone.close);
  mkdirSync(shots, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "dusk-updates-chrome-"));
  const page = await openHeadlessChrome(profile);
  try {
    for (const shot of SHOTS) for (const dark of [false, true]) {
      if (only && !only.test(shot.name)) continue;
      if (dark && !/0[13578]|11|13|17|18|19/.test(shot.name.slice(0, 2))) continue;
      const file = join(shots, `${shot.name}${dark ? "-dark" : ""}${suffix}.png`);
      const base = shot.phone ? phone.previewUrl : desk.previewUrl;
      const skin = shot.phone ? (dark ? "&scheme=dark" : "&scheme=light") : (dark ? "&skin=grok-dark" : "&skin=grok");
      try {
        await shoot(page, `${base}?${shot.query}${skin}`, shot, file, dark);
        console.log(file);
      } catch (error) {
        console.error(`${shot.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    page.close();
    await delay(500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
} finally {
  for (const close of closers) await close().catch(() => {});
  await fixture.close();
}
