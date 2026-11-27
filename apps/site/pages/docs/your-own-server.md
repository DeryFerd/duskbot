---
title: your own server
nav: your own server (advanced)
description: for people who already rent a server. paste one line and your bots live there, on around the clock.
section: start
order: 4
art: s-server
---

if you would rather not use [dusk cloud](/docs/dusk-cloud) and you're comfortable with a server, your bots can live on one you rent. it's free; you pay only for the server, and the updates, backups and bill are yours.

## what you need

- **ubuntu 22.04 or 24.04**, with **2 gb of memory or more**. more memory means more bot computers awake at once.
- root, or a user who can use `sudo`.
- a fresh server is best. don't give bots a server that holds things you wouldn't hand them.

no ports to open, no domain, nothing to install first.

## set it up

1. in the app, open the menu at the top of the sidebar, choose **add a cloud or your own server**, then your own server.
2. the app shows one line. it works once and for a limited time.
3. paste it on the server. the app shows each step; it takes about ten minutes.
4. sign in to your ai from the app (never on the server), and let the app move your bots over.

{{include ui-server}}

stopped half way? paste the same line again; it picks up where it left off. line expired? ask the app for a new one.

## another computer

on the server, run `duskbot pair --label desktop`. in the app on the other computer, choose **add a cloud or your own server**, then **already running dusk bot?**, and paste everything it printed. a server set up before this command existed gets it with its next update; until then use `sudo -u dusk /home/dusk/.local/bin/duskbot pair --label desktop`.

if it prints only a code and no link, the server has no address of its own (it's linked through the private relay). then make a line in the other computer's app and paste it on the server instead: the server moves its link to that computer, and the first one stops reaching it.

## your phone

on the server, run `duskbot pair --phone ios` (or `android`) and scan the qr with your phone's camera or in the app. that makes it a paired phone, the only kind that gets notifications. if the server has an https address it doesn't know itself (your own proxy or a cloudflare tunnel), add `--public-url https://your.host`; the server checks the address really reaches it. with no address the phone can reach, it says so and what to run instead of printing a code that can't work.

a phone that signed in with a plain code shows **notifications can't reach this phone** in its settings, with **pair this phone** to fix it. `duskbot push test` on the server sends every paired phone a test notification and says what happened; the app has the same check in settings.

## updating

a server set up with the one line updates itself while no bot is working: it looks for a new version every 15 minutes, usually has it within half an hour of a release, and goes back to the version before if the new one fails its self-test. `sudo tail /var/log/duskbot-link/server-update.log` shows what it did, and `sudo systemctl disable --now duskbot-server-update.timer` stops it (`enable --now` turns it back on). on any server, `duskbot update --check` says whether a newer version is out and what changed for it, with a link for each change. for a server you installed from the release package (`npm install --global --prefix "$HOME/.local" https://github.com/DuskBotAI/duskbot-releases/releases/latest/download/duskbot.tgz`; it isn't on the npm registry), `duskbot update` downloads the new version, checks it against the signed release and installs it; in docker it prints the `docker compose` step. the full table is in [self-hosting](https://github.com/DuskBotAI/duskbot/blob/main/docs/self-hosting.md#updating), every change is on the [changelog](/changelog).

## read it before you run it

```sh
curl -fsSLo install.sh https://dusk.bot/install.sh
curl -fsSL https://dusk.bot/install.sh.sha256
shasum -a 256 install.sh
less install.sh
```

the two fingerprints should match. your app and server talk through a relay at `link.dusk.bot`, sealed with a key only they hold, and directly where they can.

## removing it

move your bots back or export a [backup](/docs/privacy-and-data#backups) first, then:

```sh
curl -fsSL https://link.dusk.bot/uninstall | sh
```
