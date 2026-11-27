export { HEADLESS_VERBS as HEADLESS_VERB_NAMES } from "./headless/args.ts";

export const HEADLESS_USAGE = `Drive a running workspace (scripts, CI, other agents):
  duskbot doctor                    check the server answers and an engine is ready
  duskbot bots | channels | models  your bots, your rooms, the engines and their models
  duskbot run BOT "do this"         give a bot one job and wait until it and every teammate it asked are done
  duskbot send BOT "text"           send one message and return at once
  duskbot wait BOT                  wait on work already running
  duskbot messages BOT              the latest messages of a conversation
  duskbot interrupt BOT [--tree]    press Stop (--tree: and every teammate on its job)
  duskbot export BOT --out DIR      write a job's transcripts, files and screens to DIR
  duskbot events [--job THREAD]     the server's live events as JSON lines
  duskbot team apply FILE           make the workspace match a team file (team export writes one)
  duskbot engine set claude --key-env ANTHROPIC_API_KEY   give it an engine without a screen
  duskbot connect URL --code CODE --out FILE              get a token for a workspace elsewhere
  duskbot new-bot | new-channel | set-model | edit | mcp

  Server: --url URL (or DUSK_URL), --port N (or DUSK_PORT), else this computer's.
  Token: DUSK_TOKEN or --token-file FILE. --json prints one JSON document;
  progress goes to stderr (--quiet drops it). duskbot help VERB for the details.`;

export const USAGE = `duskbot: your team of AI bots, ready in a few steps

  duskbot                         set up once, then open your workspace
  duskbot setup [--data-dir DIR]
  duskbot start [the same options as serve]
  duskbot serve [--port 8799] [--data-dir DIR] [--label NAME]
                    [--public-url https://host] [--tailscale | --tunnel | --domain HOST] [--no-pair]
  duskbot pair  [--label NAME] [--client] [--phone ios|android]
                    [--public-url https://host]
  duskbot push [test]
  duskbot sessions [revoke ID]
  duskbot status
  duskbot update [--check] [--yes] [--json]
  duskbot version [--check] [--json]   (duskbot --version: the number only)
  duskbot vps status|doctor [--port N] [--data-dir DIR] [--json]
  duskbot vps logs [--service server|link|fence] [--lines 100] [--json]
  duskbot login [--email you@example.com]
  duskbot logout
  duskbot access list | add EMAIL [--chat-only] | remove EMAIL
  duskbot service install [--domain HOST | --tunnel | --tailscale] [--port N] [--data-dir DIR] | uninstall
                    [--sentinel]   (the health scan below, every two minutes, instead of the server)
  duskbot sentinel [--data-dir DIR] [--out DIR] [--once] [--json]   (read-only health scan; see --help)
  duskbot browser install [--with-deps] | status | setup
  duskbot free-backup install [--data-dir DIR]
                    [--anthropic-key-file FILE] [--cap USD] [--memory 1G]
                  | list | users NAME add|remove EMAIL [--chat-only] | suspend NAME | resume NAME
                  | delete NAME --yes [--keep-data] | upgrade   (all take --dry-run)
                  | agent [--socket PATH] [--group USER]   (root; installed by init --operator)

setup   choose AI access and optional phone access; keep existing bots and chats
start   same as duskbot: use your saved settings and open the workspace
serve   starts the server without prompts and prints a pairing link + QR code
pair    mints a pairing code against a running server (--client: chat only).
        Without --phone it signs in a web browser. --phone ios|android pairs
        the dusk bot phone app instead, the only way a phone gets
        notifications; it needs an HTTPS address the phone can reach (the
        server's own, --public-url https://host, or the link service) and
        says so plainly when there is none. --public-url names that address
        for this one code; the server checks it really is this server.
push    which paired phones can get notifications; "push test" sends each a
        test notification and says what the push service answered
sessions lists paired devices; "sessions revoke ID" signs one out
status  what the server says about itself
update  whether a newer dusk bot is out, what changed for the server, and
        the right way to update this install: an npm install downloads it,
        checks it against the signed release and installs it (asks first;
        --yes skips the question); Docker, the desktop app, a linked server
        and a git checkout get the exact step instead. --check only looks.
        Exit code: 0 up to date or updated, 10 an update is available and
        was not installed, 1 the check failed
version the version and how this copy was installed (--check: as update --check)
vps     read-only Linux VPS status, host resources, managed computers and
        bounded redacted logs, including when the server is stopped.
        Run on the VPS; no sudo, service changes or credential reads.
login   signs this machine in to a dusk bot account (an emailed code)
        and reserves its public address for --tunnel. dusk.bot does not run
        that service today; link a server with the app's one line instead
logout  releases that address and signs out
access  who may sign in with an emailed code at /pair: an address or
        @domain; --chat-only gives chat and approvals without settings.
        Takes effect at once, no restart.
service keep the server running across reboots: writes a systemd unit
        (Linux) or a launchd agent (macOS) for the same serve options and
        prints the commands that install it. Install the private
        package permanently first (see the end of this help).
browser install: the bots' browser engine (agent-browser, pinned) into the
        data dir, and Chrome for Testing into the user's browser cache
        (Linux ARM64: dusk bot's pinned download, into the data dir).
        --with-deps also installs
        the Linux libraries Chrome needs (run as root once). Then run
        browser install as the user running serve, from that user's home.
        status: what the current user and data directory have.
        setup (Linux, as root): the libraries, plus the AppArmor profile
        Ubuntu 23.10+ needs before Chrome may use its sandbox.
free-backup install: OpenCode's own build (pinned), the free backup AI, into
        the data dir, unless an OpenCode is already installed. Run it as the
        user running serve.
--tailscale  serve over your tailnet: Tailscale terminates HTTPS and the
             link uses this machine's MagicDNS name (needs Tailscale signed in
             and HTTPS certificates enabled for the tailnet)
--tunnel     serve at a public https://c-… address through a
             Cloudflare tunnel: no domain, no proxy, no open port. Run
             \`duskbot login\` once on this machine first. dusk.bot does not
             run that service today; use --tailscale, --domain or the app's
             one line instead.
--domain     serve at https://HOST on your own domain: a pinned Caddy is
             downloaded once and run alongside the server, and gets the
             certificate itself. Point the domain's DNS at this machine and
             open ports 80 and 443.

--no-open   do not open a browser window
--no-pair   skip phone setup and do not print a pairing code
--local     start locally this time, ignoring saved remote-access settings

${HEADLESS_USAGE}

Install once from the private archive your operator supplies, then type
\`duskbot\` (add $HOME/.local/bin to PATH if needed). Node 24+ is required.
  npm install --global --prefix "$HOME/.local" ./duskbot-private.tgz
The desktop's Add your VPS flow installs it on a server for you.
`;

/** `duskbot COMMAND --help`: that command's usage lines and what it does, from USAGE; the whole of it for one not there */
export function commandHelp(command: string, usage = USAGE): string {
  const lines = usage.split("\n");
  const picked: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const usageLine = line.startsWith(`  duskbot ${command} `) || line === `  duskbot ${command}`;
    const about = line.startsWith(`${command} `) && /^\S+\s{2,}|^\S+ \S/.test(line) && !line.startsWith("  ");
    if (!usageLine && !about) continue;
    if (about && picked.length && picked.at(-1) !== "") picked.push("");
    picked.push(line);
    // a usage line's continuations are indented further; a description's run until the next flush-left line
    while (i + 1 < lines.length && (usageLine ? /^ {6,}\S/.test(lines[i + 1]!) && !lines[i + 1]!.startsWith("  duskbot ") : /^ {2,}\S/.test(lines[i + 1]!))) picked.push(lines[++i]!);
    if (about) picked.push("");
  }
  return picked.length ? `${picked.join("\n").trimEnd()}\n\nAll commands: duskbot --help` : usage;
}
