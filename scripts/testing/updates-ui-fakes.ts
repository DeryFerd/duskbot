// The answers the updates previews give in place of a server and dusk.bot: ?server=behind|current|managed,
// ?changelog=0 (no changelog.json), ?feed=behind|current|missing (latest.json's android part), ?old=1 (the server needs a newer phone app). Served only by
// scripts/verify-updates-ui.ts.
export const SAMPLE_CHANGELOG = {
  v: 1,
  releases: [
    { version: "0.2.32", date: "2026-11-27", items: [
      { text: "Settings has Check for updates on the phone too, with this phone's and the server's version", area: "phone" },
      { text: "Android says when a newer APK is out and opens it", area: "phone", issue: 353 },
      { text: "Enter queues a message while a bot works; Cmd+Enter steers it", area: "desktop" },
      { text: "Pasting long text says it became a file", area: "desktop" },
      { text: "The CLI is on every GitHub release", area: "cli" },
      { text: "iPhone pairing from the CLI makes a phone link, not a sign-in code", area: "server", issue: 352 },
    ] },
    { version: "0.2.31", date: "2026-11-25", items: [
      { text: "Android registers for notifications as soon as it pairs", area: "phone" },
      { text: "Zip files can be attached to a chat", area: "all" },
      { text: "Bots post a short note when they add or change a skill", area: "all" },
    ] },
    { version: "0.2.30", date: "2026-11-21", items: [
      { text: "The model picker remembers your last pick per bot", area: "desktop" },
      { text: "Docker servers can update themselves from Settings", area: "server" },
    ] },
  ],
};

export function installUpdateFakes(params: URLSearchParams, own = "0.2.31") {
  const server = params.get("server") ?? "current";
  const check = server === "managed" ? { current: own, install: "managed", available: false }
    : server === "desktop" ? { current: own, install: "desktop", available: false }
    : server === "newer" ? { current: "0.2.32", install: "npm", available: false, latest: "0.2.32" }
    : server === "behind" ? { current: "0.2.29", install: "docker", available: true, latest: own, releaseUrl: `https://github.com/DuskBotAI/duskbot/releases/tag/v${own}`, command: "docker compose pull dusk && docker compose up -d" }
    : { current: own, install: "docker", available: false, latest: own, releaseUrl: `https://github.com/DuskBotAI/duskbot/releases/tag/v${own}`, command: "docker compose pull dusk && docker compose up -d" };
  const changelog = params.get("changelog") === "0" ? null : SAMPLE_CHANGELOG;
  const feed = params.get("feed") ?? "behind";
  const latest = { v: 1, version: own, ...(feed === "missing" ? {} : { android: { version: feed === "behind" ? "1.2.12" : "1.2.9", code: feed === "behind" ? 13 : 10, url: "https://github.com/DuskBotAI/duskbot-releases/releases/download/v0.2.31/DuskBot.apk" } }) };
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0];
    if (url.startsWith("https://dusk.bot/releases/changelog.json")) return changelog ? json(changelog) : json({ error: "not found" }, 404);
    if (url.startsWith("https://dusk.bot/releases/latest.json")) return json(latest);
    if (path === "/.well-known/duskbot/environment" && params.get("old") === "1") return json({ version: own, capabilities: { api: 1, minMobile: 99 } });
    if (path === "/api/updates/check") return new Promise((done) => setTimeout(() => done(json(check)), 400));
    if (path === "/api/updates/changelog") return changelog ? json(changelog) : json({ v: 1, releases: [] });
    return real(input, init);
  };
}
