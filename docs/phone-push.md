# Phone push

A paired phone gets a push for a notification (a reply, a question, an approval) the person has not already seen. A
message they are looking at, or already read on any device, never pushes.

## How the workspace decides

The workspace (your computer or server) decides, per phone:

- The app tells the workspace when it opens, which conversation is on screen (none on the chat list), and when it goes
  to the background (`PUT /api/mobile/presence` with `away` and `threadId`). It keeps saying it is open every 25 seconds;
  an app that stops for 60 seconds (killed, suspended, out of signal) counts as away. A phone that never reported counts
  as away.
- A notification for the conversation the open app shows is never pushed to that phone.
- Every other push waits 4 seconds first. It is dropped if, by then, the notification was read anywhere (the desktop
  window open on that chat, the phone, "mark all read") or the phone opened that conversation. Several in one
  conversation within those seconds send once, the newest.
- A push the service could not take is tried again after 10 seconds and after 60 seconds, while it is still unread and
  not on screen. A token APNs or FCM calls dead is dropped; the app registers again next time it opens.

On the iPhone, a push that lands while the app is open shows as the system's own banner, unless it is about the
conversation on screen, which shows nothing. Pushes already in Notification Center are removed once read: when that
conversation opens, when a read arrives from another device while the app is open, and each time the app comes back.
A phone that stays locked keeps a push read elsewhere until the app next opens.

The desktop app posts its own system banners from the main process (`electron/desktop-notifications.mjs`), except while
its window has focus; the dock, island and unread dots carry the rest.

The code is in `server/mobile/presence.ts` (where each phone is), `server/mobile/link.ts` (the grace and wiring) and
`server/mobile/push.ts` (sending).

## Checking it end to end

`duskbot push` lists the paired phones and whether each gave the server a push token; `duskbot push test` sends each
one a test notification right away (`POST /api/mobile/push/test`, no grace or retries) and prints what APNs, FCM or the
relay answered: sent, not registered, a dead token (dropped), not deliverable, or failed. The phone app has the same
check in Settings (**Send a test notification**), for that phone alone. A phone that only signed in with a code, not
paired, is not a paired phone and gets no pushes; the app says so in Settings and offers **Pair this phone**
(`POST /api/mobile/device`, its own native session only, never a browser's cookie, a person's email sign-in or a team
member's).

## Where pushes leave from

APNs and FCM accept pushes only from whoever holds the app's keys. A workspace sends a push:

1. with its own keys, when `DUSK_APNS_*` or `DUSK_FCM_SERVICE_ACCOUNT_FILE` are set on it (below), else
2. through a push relay: `DUSK_PUSH_RELAY` if set (`off` turns this off), else the link service its VPS link agent uses,
   else `DUSK_MOBILE_RELAY`, else `https://link.dusk.bot`.

The relay is `POST /v1/push` on the link service (`apps/link-service/src/push-relay.mjs`). It sees the device token, APNs or
FCM, the bot's name and the ids a tap opens (notification, bot, conversation, room). It never gets a notification's
title or any message text, keeps nothing, and logs no token. Apple and Google see the same: the lock screen shows the
bot's name and "New message". It allows 60 pushes a minute per device token and 600 per address.

A relay sends only for the services it holds keys for; `GET /v1/push` lists them. When it answers a push with
`not_configured`, the workspace logs once (`mobile push: the push relay at ... has no FCM keys, so Android phones get
notifications only while the app is open`), stops sending that service to it, and asks again after 30 minutes. A
phone's push registration (`PUT /api/mobile/push`) answers `delivering: false` once that is known.

## What a self-hosted server does today

Checked on 2026-11-25:

- `https://link.dusk.bot/v1/push` and `https://link-in.dusk.bot/v1/push` answer `{"services":["apns","fcm"]}`: both
  link nodes hold the APNs key and the FCM service account.
- Android builds made with `apps/mobile/scripts/build-android-apk.sh` or `build-android-release.sh` carry the Firebase
  config (Firebase project `dusk-bot-514309`, app `bot.dusk.mobile`), so the app gets an FCM token and registers it.
  An Android build made without `google-services.json` (CI's smoke build, a plain `cap run android`) has no push and
  never asks for it.
- So a self-hosted server with no `DUSK_APNS_*` and no `DUSK_FCM_SERVICE_ACCOUNT_FILE` of its own sends both through
  the public relay:
  - iPhone: pushes arrive, as long as the token's environment matches (a TestFlight or App Store build; an Xcode
    build gives a sandbox token, see below).
  - Android: pushes arrive on an app built with the Firebase config. An app installed before that build has no token
    and stays without push until it is updated.
- A server with its own keys never uses the relay for that service.

## Where the keys are

- Firebase project `dusk-bot-514309` (the Google Cloud project of the same id, account siddz.dev), Android app
  `bot.dusk.mobile`. Cloud Messaging API (v1) is on.
- Service account `fcm-sender@dusk-bot-514309.iam.gserviceaccount.com`, role Firebase Cloud Messaging API Admin only.
  Its JSON key is `~/.config/duskbot/fcm-service-account.json` on the Mac (mode 600, a secret), on contabo at
  `/root/omb-link-data/fcm-service-account.json` and on oracle-in at `/etc/dusk-link-node-fcm.json` (owner `dusklink`),
  set as `DUSK_FCM_SERVICE_ACCOUNT_FILE` in each node's env (`deploy/account/PRODUCTION-CLOUD.md`, step 7).
- `google-services.json` (public identifiers, kept out of the public repo like the other release inputs) is
  `~/.config/duskbot/google-services.json`; the Android build scripts copy it to `apps/mobile/android/app/`
  (`DUSK_ANDROID_GOOGLE_SERVICES` overrides the source) and stop when it is missing.
- APNs: `DUSK_APNS_*` on both nodes for `bot.dusk.mobile` (step 6 of the same file). The relay picks the sandbox or
  production APNs host from the token's environment, so a test from an Xcode build needs a development web build
  (below) or TestFlight.
- A self-hosted person who wants no relay at all sets their own `DUSK_APNS_*` / `DUSK_FCM_SERVICE_ACCOUNT_FILE`, which
  only works with an app they sign themselves (APNs and FCM accept pushes only from the app's own keys), and
  `DUSK_PUSH_RELAY=off`.

## Setup you have to do

For an app you sign yourself. None of this is in the repo: keys and Firebase files are secrets or tied to your
developer accounts.

### iOS (APNs)

1. In the Apple Developer account that signs the app (bundle id `bot.dusk.mobile`), open Certificates, IDs &
   Profiles, Keys, and create a key with **Apple Push Notifications service (APNs)** enabled. Download the `.p8` file
   (only once) and note its Key ID and your Team ID.
2. The `aps-environment` entitlement is already in the project (`apps/mobile/ios/App/App/App.entitlements`). In the
   developer account, turn on **Push Notifications** for the app id, and select your team for the App target in
   `apps/mobile/ios/App/App.xcodeproj` so Xcode makes a profile that carries it.
3. Put the key where the pushes leave from (the link service host for the relay, or the workspace itself) and set:
   - `DUSK_APNS_KEY_FILE`: path to the `.p8` file (readable only by the service user, `chmod 600`)
   - `DUSK_APNS_KEY_ID`: the key's ID
   - `DUSK_APNS_TEAM_ID`: your Team ID
   - `DUSK_APNS_TOPIC`: `bot.dusk.mobile`
4. Restart the link service (or the workspace). `GET /v1/push` on the link service should answer
   `{"services":["apns",...]}`.

A build run from Xcode gets sandbox tokens; TestFlight and App Store builds get production tokens. The app marks its
token sandbox only when its web part was built in development mode, so for a push test from Xcode build with
`DUSK_MOBILE_DEV_URL` (live reload) or use TestFlight; a production-marked sandbox token is refused by APNs and dropped.

### Android (FCM)

1. In the Firebase console, create a project (or use one), add an Android app with package `bot.dusk.mobile`,
   and download `google-services.json` into `apps/mobile/android/app/` (git-ignored by `apps/mobile/.gitignore`; the
   build applies the Google services plugin only when the file exists). Rebuild the app.
2. Make a service account with only the Firebase Cloud Messaging API Admin role and create a JSON key for it (or, in
   Project settings, Service accounts, generate a new private key). That JSON file is a secret.
3. Where the pushes leave from, set `DUSK_FCM_SERVICE_ACCOUNT_FILE` to that file's path (`chmod 600`) and restart.

### Check it

1. Pair the phone, allow notifications when asked, and open Settings, Notifications in the app once.
2. Put the app in the background, then make a bot answer you (or ask you something) from the desktop.
3. The phone should get "{bot name}: New message" within a few seconds; tapping it opens that conversation.

If nothing arrives, the workspace log says `mobile push: no APNs or FCM credentials and no push relay on this server`
when it has neither, or `mobile push: the push relay at ... has no FCM keys` (or APNs) when the relay lacks that
service, and `GET /v1/push` on the relay lists what the relay can send.
