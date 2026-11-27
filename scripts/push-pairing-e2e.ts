// Phone pairing and push end to end on an isolated fixture: a self-hosted server with no link service and no DUSK_PUBLIC_URL, reached by
// the phone through an https address in front of it (a Cloudflare tunnel or proxy, here a local TLS proxy). Runs
// `duskbot pair --phone ios --public-url <that address>` for real, redeems the code as the phone app does, registers for
// push, and checks `duskbot push test` reaches the push relay (a local stub standing in for link.dusk.bot).
//   node --experimental-strip-types scripts/push-pairing-e2e.ts [--out DIR]
// It makes its own throwaway certificate (openssl) and re-runs itself with NODE_EXTRA_CA_CERTS so node trusts it.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { appLinkFromUniversal, parseMobilePairingLink, type MobileRedeemResponse } from "../shared/mobile-link.ts";

const out = process.argv.includes("--out") ? resolve(process.argv[process.argv.indexOf("--out") + 1]!) : null;
const here = mkdtempSync(join(tmpdir(), "dusk-push-e2e-"));

const listen = (server: Server | ReturnType<typeof createHttpsServer>) => new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port)));

async function main(): Promise<boolean> {
  const tls = process.env.DUSK_E2E_TLS_DIR!;
  let ok = true;
  const check = (step: string, pass: boolean, detail = "") => { ok &&= pass; console.log(`${pass ? "ok  " : "FAIL"} ${step}${detail ? `: ${detail}` : ""}`); };

  // the push relay stub: what link.dusk.bot's /v1/push says and does, recording what it was asked to send
  const pushes: Array<Record<string, unknown>> = [];
  const relay = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/push" && req.method === "GET") return res.end(JSON.stringify({ services: ["apns", "fcm"] }));
      if (req.url === "/v1/push" && req.method === "POST") { pushes.push(JSON.parse(body)); return res.end(JSON.stringify({ outcome: "sent" })); }
      res.statusCode = 404; res.end("{}");
    });
  });
  const relayPort = await listen(relay);

  const fixture = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-dusk.ts", "launch"], {
    stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, DUSK_PUSH_RELAY: `http://127.0.0.1:${relayPort}` },
  });
  const harness = await new Promise<string>((done, fail) => {
    let text = "";
    fixture.stdout.on("data", (chunk: Buffer) => { text += chunk; const match = /"url":\s*"(http:\/\/127\.0\.0\.1:(\d+))"/.exec(text); if (match) done(match[1]!); });
    fixture.once("exit", (code) => fail(new Error(`fixture exited ${code}`)));
  });
  const port = new URL(harness).port;

  // the server's public https address it does not know about (no DUSK_PUBLIC_URL): a TLS proxy to the fixture
  const { readFileSync } = await import("node:fs");
  const front = createHttpsServer({ key: readFileSync(join(tls, "key.pem")), cert: readFileSync(join(tls, "cert.pem")) }, (req, res) => {
    const upstream = httpRequest(`${harness}${req.url}`, { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}`, "x-forwarded-proto": "https" } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => { res.statusCode = 502; res.end(); });
    req.pipe(upstream);
  });
  const publicUrl = `https://127.0.0.1:${await listen(front)}`;
  // never a synchronous child: the server's check of the https address comes back through this process's proxy
  const cli = (...args: string[]) => runText(["--experimental-strip-types", "server/duskbot.ts", ...args, "--port", port]);
  const transcript: string[] = [];
  try {
    const paired = await cli("pair", "--label", "iPhone", "--phone", "ios", "--public-url", publicUrl);
    transcript.push(`$ duskbot pair --label iPhone --phone ios --public-url ${publicUrl}`, paired.text);
    check("pair --phone ios --public-url exits 0", paired.code === 0, `exit ${paired.code}`);
    check("it prints a phone pairing, not a sign-in invite", /dusk\.bot\/m\/pair#/.test(paired.text) && !paired.text.includes("duskbot://pair?"));
    check("it says where iPhone notifications go", paired.text.includes(`notifications:  iPhone (APNs) through http://127.0.0.1:${relayPort}`));

    // the phone app: the QR's universal link carries the duskbot://link payload
    const link = /open this link on the phone:\s+(\S+)/.exec(paired.text)?.[1] ?? "";
    const payload = parseMobilePairingLink(appLinkFromUniversal(link) ?? "");
    check("the code carries the --public-url route", payload?.via?.some((route) => route.kind === "https" && route.url === publicUrl) === true, JSON.stringify(payload?.via));
    const redeemed = await fetch(`${publicUrl}/api/mobile/redeem`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: payload?.credential, attemptId: "e2e-attempt-1", device: { name: "Ram's iPhone", platform: "ios", app: "1.2.13", install: "install-e2e-0123456789" } }),
    });
    const phone = await redeemed.json() as MobileRedeemResponse;
    check("the phone app redeems it over the https address as a paired phone", redeemed.status === 200 && typeof phone.device?.id === "string", `${redeemed.status}`);
    const asPhone = (path: string, init: RequestInit = {}) => fetch(`${publicUrl}${path}`, { ...init, headers: { authorization: `Bearer ${phone.token}`, "content-type": "application/json" } });
    const registered = await asPhone("/api/mobile/push", { method: "PUT", body: JSON.stringify({ service: "apns", token: "ab".repeat(32), environment: "production" }) });
    check("the phone registers for push", registered.status === 200, JSON.stringify(await registered.json()));

    const before = pushes.length;
    const tested = await cli("push", "test");
    transcript.push("$ duskbot push test", tested.text);
    check("duskbot push test exits 0", tested.code === 0, `exit ${tested.code}`);
    check("the push relay got the test push for that phone's token", pushes.length === before + 1 && pushes.at(-1)?.token === "ab".repeat(32) && (pushes.at(-1)?.message as { kind?: string })?.kind === "test", JSON.stringify(pushes.at(-1)));
    const fromPhone = await asPhone("/api/mobile/push/test", { method: "POST", body: "{}" });
    const phoneTest = await fromPhone.json() as { results: Array<{ outcome: string }> };
    check("the phone's own Send a test notification is sent", fromPhone.status === 200 && phoneTest.results.length === 1 && phoneTest.results[0]!.outcome === "sent");

    const status = await cli("push");
    transcript.push("$ duskbot push", status.text);
    check("duskbot push lists the phone as registered", status.text.includes("Ram's iPhone (ios): registered for APNs"));

    // a phone that only signed in with the old sign-in invite makes itself a paired phone (Settings, Pair this phone)
    const invite = await (await fetch(`${harness}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "old iPhone" }) })).json() as { credential: string };
    const signedIn = await (await fetch(`${publicUrl}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: invite.credential, deviceName: "Old iPhone", pairRequestId: "e2e-old-1" }) })).json() as { token?: string };
    const asOld = (path: string, init: RequestInit = {}) => fetch(`${publicUrl}${path}`, { ...init, headers: { authorization: `Bearer ${signedIn.token}`, "content-type": "application/json" } });
    const notYet = await asOld("/api/mobile/push", { method: "PUT", body: JSON.stringify({ service: "apns", token: "cd".repeat(32) }) });
    check("a signed-in phone is told it is not a paired phone", notYet.status === 403 && (await notYet.json() as { code?: string }).code === "not_paired");
    const adopted = await asOld("/api/mobile/device", { method: "POST", body: JSON.stringify({ name: "Old iPhone", platform: "ios", app: "1.2.13", install: "install-e2e-old-0123456" }) });
    check("Pair this phone makes it a paired phone", adopted.status === 200);
    const nowRegistered = await asOld("/api/mobile/push", { method: "PUT", body: JSON.stringify({ service: "apns", token: "cd".repeat(32) }) });
    const oldTest = await asOld("/api/mobile/push/test", { method: "POST", body: "{}" });
    check("then it registers and its test push is sent", nowRegistered.status === 200 && (await oldTest.json() as { results: Array<{ outcome: string }> }).results[0]?.outcome === "sent" && pushes.at(-1)?.token === "cd".repeat(32));

    // without an address the phone can reach, --phone says so and makes no code
    const nowhere = await cli("pair", "--phone", "android");
    transcript.push("$ duskbot pair --phone android   (no address, no link service)", nowhere.text);
    check("pair --phone with no address exits 1 and says why", nowhere.code === 1 && nowhere.text.includes("could not get notifications"));
    const wrong = await cli("pair", "--phone", "ios", "--public-url", "https://127.0.0.1:9");
    transcript.push("$ duskbot pair --phone ios --public-url https://127.0.0.1:9   (not this server)", wrong.text);
    check("a --public-url that is not this server is refused", wrong.code === 1 && wrong.text.includes("does not answer as this server"));
  } finally {
    if (out) writeFileSync(join(out, "cli-transcript-after.txt"), `${transcript.join("\n")}\n`);
    fixture.kill("SIGINT");
    relay.close();
    front.close();
  }
  return ok;
}

function runText(args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, DUSK_DATA_DIR: join(tmpdir(), "dusk-push-e2e-cli") }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { text += chunk; });
    child.once("exit", (code) => done({ code: code ?? 1, text }));
  });
}

if (!process.env.NODE_EXTRA_CA_CERTS) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(here, "key.pem"), "-out", join(here, "cert.pem")], { stdio: "ignore" });
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, NODE_EXTRA_CA_CERTS: join(here, "cert.pem"), DUSK_E2E_TLS_DIR: here } });
  child.once("exit", (code) => { rmSync(here, { recursive: true, force: true }); process.exit(code ?? 1); });
} else {
  void main().then((ok) => process.exit(ok ? 0 : 1), (error) => { console.error(error); process.exit(1); });
}
