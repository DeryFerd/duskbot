# user-sim

Simulated people get real work done with dusk bot, over several conversations and days, so changes to the bot are
judged on facts. Each scenario gets its own headless dusk bot server from `--repo` (its own data folder under the
system temp folder, nothing from this Mac's real bots), the bot engine on `--model` through the gateway, and a person's
world:

- **Connected apps** (`connectors.mjs`): Gmail, Google Calendar, Slack, GitHub, notes, a shop and a CRM as stdio MCP
  servers in `config.json`'s `mcpServers`, the bot's normal custom-MCP path. They read and write one JSON state file,
  so every send, invite, post, comment, refund and note is ground truth. A step can make a tool fail N times.
- **Home folder**: files the person keeps (`~/Documents/...`).
- **Clock** (`clock.mjs`, preloaded into the server and the apps): the simulation starts on the world's weekday and
  time in the person's time zone, and `advance` steps move days ahead in seconds. dusk bot's due timer reads the wall
  clock every minute, so routines whose time passes run within a minute.
- **The person** (`person.ts`): gpt-6.2-sol playing the persona toward each conversation's goal, typing in their style.

Nothing the bot sees says it is staged: no "test" or "eval" words in names, data, folders or prompts (the validator
refuses them), realistic people, inboxes, calendars and repos.

Grading: ground-truth checks (`checks.ts`) over app state, routines and their runs, what the bot said, what it sent on
its own, its memory and the home folder; then a judge (`judge.ts`, gpt-6.2-sol) scores the whole story 1-5 (plus
quality, tone, needless questions) and names failure patterns from one fixed list. A scenario **passes** when every
check is green, the judge says the goal really happened, and the score is 4 or more. Metrics: task success (checks),
person turns, tool steps, failed turns, time to first text (from `/api/events`), turn latency, tokens and cost
(the engine's own cost, else an estimate from `--price-in` / `--price-out` per million tokens), memory recall
(checks marked `recall`).

## Run

```
node --experimental-strip-types scripts/user-sim/run.ts --out <dir outside the repo> \
  [--only id,id] [--tag memory,routine] [--parallel 4] [--repeat 1] \
  [--model gpt-6.2-sol] [--engine openai-compat|codex] [--person gpt-6.2-sol] [--judge gpt-6.2-sol] [--label baseline] [--keep] [--repo <checkout>]
node --experimental-strip-types scripts/user-sim/summary.ts <dir>                 # rewrite summary.json / summary.md
node --experimental-strip-types scripts/user-sim/summary.ts <before> <after>      # diff two runs
```

Compare two runs (a run folder, its `summary.json`, or a saved `baseline.json`):

```
node --experimental-strip-types scripts/user-sim/summary.ts baseline.json <new-run>/summary.json
```

`summary.json` records the checkout and the last commit touching `server/` or `shared/` (`codeCommit`), the bot model,
the totals, failure patterns, per-tag counts and one row per scenario (category, pass, task success, judge scores,
needless questions, recall, turns, tool steps, time to first text, turn latency, tokens, cost, failed checks, why).
With one model run per scenario, expect a scenario or two to flip between runs on noise alone; use `--repeat 2` or
more before trusting a single flip.

Run it on the Mac (never on contabo). The gateway key comes from `DUSK_EVAL_KEY` or the mchat `.env`
(`scripts/memory-eval/sandbox.ts`). A rerun into the same `--out` skips scenarios already in `results.jsonl`.
`--out` gets `results.jsonl`, `summary.json`, `summary.md` and one transcript per scenario in `transcripts/`.
A scenario takes 3 to 12 minutes; `--parallel 4` runs the library in about an hour.

## Add a scenario

One JSON file in `scenarios/` (its id is the file name); `scenario.ts` is the format and the validator. A world in
`worlds/` holds the persona and their apps' data; times are relative to the start: `"@-1d 14:20"`, `"@+2d 09:00"`,
`"@-3h"`.

```json
{
  "title": "Remember a meeting rule and use it two days later",
  "world": "founder",
  "tags": ["memory"],
  "bots": [{ "name": "Ledger", "soul": "You look after the books." }],
  "seed": { "mail": [{ "from": "Leo <leo@northwind.co>", "subject": "sync?", "body": "...", "date": "@-2h" }] },
  "steps": [
    { "chat": { "label": "s1", "goal": "the person's intent, in their voice", "opener": "optional first message", "maxTurns": 3 } },
    { "advance": "+2d 09:00", "label": "later" },
    { "inject": { "mail": [{ "from": "...", "subject": "...", "body": "..." }] } },
    { "fault": { "gmail_send": { "times": 1, "error": "503 Service Unavailable" } } },
    { "settle": { "seconds": 90 } },
    { "chat": { "label": "s2", "goal": "...", "thread": "new", "bot": "Ledger", "replyTo": "regex of an earlier bot message" } }
  ],
  "checks": [
    { "label": "booked", "app": "events", "where": { "attendees": "leo@northwind" }, "min": 1 },
    { "label": "not before 10", "app": "events", "where": { "start": "T0[0-9]:" }, "max": 0, "recall": true },
    { "label": "routine ran", "routine": { "where": { "name": "brief" }, "ran": true } },
    { "label": "followed up", "proactive": { "after": "later", "match": "leo" } },
    { "label": "said it", "said": { "step": "s2", "match": "10", "not": "before 10" } },
    { "label": "kept", "memory": { "match": "10 ?am" } },
    { "label": "file", "file": { "path": "Documents/notes.md", "match": "leo" } }
  ],
  "judge": "what a great outcome looks like, tone included"
}
```

Steps: `chat` (a conversation: `thread` is `new` by default, `main`, `same`, or a word naming one to come back to),
`advance` (`+1d 08:05`, `+3h`, `+45m`), `inject` (new mail, events, Slack messages, orders, files arrive), `fault`,
`settle` (wait for runs and memory upkeep). Between conversations the runner waits for memory upkeep to file the facts.
App checks address the state by path: `sent`, `drafts`, `events`, `cancelled`, `mail`, `notes`,
`slack.channels.<name>.messages`, `github.repos.0.issues`, `shop.orders`, `crm.deals`, `log`; `where` maps a field
(dotted paths allowed) to a case-insensitive regex. Regexes stay tolerant ("thu|thursday").

Before a long run, check the library: `node --experimental-strip-types -e 'const s = await import("./scripts/user-sim/scenario.ts"); console.log(s.loadScenarios().flatMap(s.validate))'`.

## Capability (`--tag capability`)

Five `cap-*` scenarios replay simple tasks that made people uninstall: a PR's CI checked and commented on with a signed-in
`gh` instead of the browser, files found anywhere in the home folder (by name and by a phrase inside, iCloud Drive
included), saying which browser the bot uses and using it, uninstalling an app and reading the free disk space, and a
request sent at night while the AI is at its usage limit that must carry on by itself after the reset. They use:

- `"computer": true`: Works on Auto and the bot's own browser, as a new bot in the app, and this computer's shell (the
  server runs as `duskbot serve` would start it). The bot works on this Mac for real: keep app and file names in seeds
  that exist nowhere on it.
- `"cli": ["gh"]`: a signed-in `gh` (`gh.mjs`) on the server's PATH over the same app state, logged as app `gh`.
- `"apps": [...]`: the connected apps, replacing the world's list.
- `"limit": { "until": "@+1d 02:00", "message": "..." }`: the bot's AI refuses every call with a 429 and that message
  until then on the simulated clock (`limit-proxy.ts`).
- checks `{ "tool": { "step", "match" }, "min", "max" }` over the bot's tool calls (name and input) and
  `{ "gone": { "path" } }` for a file or folder that must be removed. The judge sees the tool calls for these scenarios.

## Personality (`--tag vibe`, `vibe.ts`)

Twelve `vibe-*` scenarios across the five worlds test how the bot feels to live with while it works: a rude day and a
friendly next morning, a sad person who shares something sensitive and asks for a plan two days later, banter before
a real customer email, preferences and an allergy used days later, a fact that changes (who is on call), an ambiguous
ask, an honest opinion, a watch that reports back on its own, small talk and good news, a terse developer, and a
standing rule used later. Fifteen `banter-*` scenarios (`--tag banter`) are the humor bar: the Poke mountain-time jab,
teasing, a requested roast, swearing, a nickname used the next day, formal people who should still meet a person, and a
serious moment where the jokes must stop. After a run:

```
node --experimental-strip-types scripts/user-sim/vibe.ts score <run dir>          # rubric per story, writes vibe-scores.json
node --experimental-strip-types scripts/user-sim/vibe.ts pair <dir A> <dir B>     # blind A vs B on the same scenarios
node --experimental-strip-types scripts/user-sim/vibe.ts table <dir>...           # one row per run
```

The rubric scores six dimensions 1-5 (funny and has personality, texts like a friend, personal, gets it done, memory
used well, never mean or creepy), judged against a real Poke chat as the bar with corporate or bland tone penalised and counts straight from the bot's lines (words per message, em dashes, help-desk phrases,
emoji). A pair is judged twice with the order swapped, and a side wins a dimension only when both orders pick it; the
judge never sees which build is which. Compare builds by running the same scenarios with `--repo` on each checkout.

Four `voice-*` scenarios (`--tag voice`) check that a bot's seriousness follows its role: an ops/CI bot, a coding bot
teased by its developer and a finance bot whose person shifts register should answer output first with almost no
banter, while a companion bot keeps its humor. The Poke bar does not fit a work bot, so pair them with
`vibe.ts pair <A> <B> --rubric fit` (clear output, voice fits the role, done, tactful).

`--engine codex` runs the bot on dusk's Codex driver with its own `CODEX_HOME` in the sandbox and the gateway as its
Company endpoint, so a voice change is checked where the prompt is appended to Codex's own instructions. Two
`everyday-*` scenarios are plain casual chats (a hello that drifts into one small ask), for personality from the first
message rather than only when teased.
