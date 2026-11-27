import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPair, type CliOptions } from "./cli.ts";
import { SetupCancelled } from "./cli-prompts.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const mocks = vi.hoisted(() => ({
  readCliStartup: vi.fn(),
  createTunnelAccount: vi.fn(), describeTunnelAccount: vi.fn(), tailscaleStatus: vi.fn(),
  ui: { log: vi.fn(), choose: vi.fn(), ask: vi.fn(), secret: vi.fn(), confirm: vi.fn() },
}));
vi.mock("./cli-setup.ts", () => ({ readCliStartup: mocks.readCliStartup }));
vi.mock("./cli-prompts.ts", async (original) => ({
  ...await original<typeof import("./cli-prompts.ts")>(), defaultSetupIo: () => mocks.ui,
}));
vi.mock("./tailscale.ts", () => ({
  tailscaleStatus: mocks.tailscaleStatus,
  tailscaleServe: vi.fn(), tailscaleServeOff: vi.fn(), explainTailscaleFailure: vi.fn(),
}));
vi.mock("./tunnel.ts", () => ({
  createTunnelAccount: mocks.createTunnelAccount, describeTunnelAccount: mocks.describeTunnelAccount,
  cleanupTunnelOrigin: vi.fn(), createTunnelOrigin: vi.fn(), describeTunnelState: vi.fn(),
  ensureCloudflared: vi.fn(), guardianEntry: vi.fn(), startTunnel: vi.fn(), tunnelAccess: vi.fn(),
}));

const advertisedOrigin = "https://current.example.test";
const explicitOrigin = "https://override.example.test";
const code = "ABCD-EFGH-JKLM";
const typed = "WXYZ-2345-6789";
const ttyDescriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
let dataDir: string;
let options: CliOptions;
let publicUrl: string | null;
/** what POST /api/mobile/pairing answers in this test */
let mobilePairing: (body: Record<string, unknown>) => Response;
const fetchMock = vi.fn<typeof fetch>();
const local = () => `http://127.0.0.1:${options.port}`;
const httpsPairing = (origin: string) => Response.json({
  link: "duskbot://link?v=2&p=fixture", code: typed, expiresAt: Date.now() + 300_000,
  payload: { via: [{ kind: "https", url: origin }] },
});

beforeEach(() => {
  vi.resetAllMocks();
  // The shared test setup supplies a throwaway HOME before module imports.
  dataDir = mkdtempSync(join(process.env.HOME!, "cli-pair-"));
  vi.stubEnv("DUSK_DATA_DIR", dataDir);
  options = { command: "pair", port: 18451, dataDir, tailscale: false, tunnel: false, client: false, pair: true, json: false };
  publicUrl = advertisedOrigin;
  mobilePairing = (body) => httpsPairing(typeof body.origin === "string" ? body.origin : advertisedOrigin);
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  mocks.ui.choose.mockResolvedValue(0);
  mocks.createTunnelAccount.mockReturnValue({ credentials: { read: () => ({}) } });
  mocks.describeTunnelAccount.mockReturnValue({ address: "https://old-tunnel.example.test", email: "fixture@example.test" });
  mocks.tailscaleStatus.mockResolvedValue({ status: { dnsName: "old-tailnet.example.test" } });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `${local()}/api/health`) return Response.json({ app: "duskbot", pid: 12345 });
    if (url === `${local()}/api/auth/pairing`) {
      if (init?.method === "POST") return Response.json({ code, expiresAt: Date.now() + 300_000, url: `${advertisedOrigin}/pair#code=${code}` });
      return Response.json({ pairings: [], publicUrl });
    }
    if (url === `${local()}/api/mobile/pairing` && init?.method === "POST") return mobilePairing(JSON.parse(String(init.body)));
    if (url === `${local()}/api/mobile/push`) return Response.json({ own: [], relay: "https://link.dusk.bot", relayServices: ["apns", "fcm"] });
    // No real network fallback is allowed, including stale saved addresses.
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const [index, stream] of [process.stdin, process.stdout].entries()) {
    const descriptor = ttyDescriptors[index];
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
  await removeTempDir(dataDir);
});

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => ({ url: String(url).replace(local(), ""), body: JSON.parse(String(init?.body ?? "{}")) }));
const transcript = () => [...mocks.ui.log.mock.calls, ...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].map(([line]) => String(line)).join("\n");

function expectPhonePairing(origin?: string): void {
  expect(posts()).toEqual([{ url: "/api/mobile/pairing", body: expect.objectContaining({ scopes: ["client"], ...(origin ? { origin } : {}) }) }]);
  if (!origin) expect(posts()[0]!.body).not.toHaveProperty("origin");
  // the server checks the address itself; the CLI never sends anything to it
  expect(transcript()).toContain(typed);
  expect(transcript()).toMatch(/[▀▄█]/);
  expect(transcript()).toContain("notifications:  iPhone (APNs) through https://link.dusk.bot");
  expect(transcript()).not.toContain("duskbot://pair?");
  expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("https://"))).toHaveLength(0);
}

describe("guided phone pairing", () => {
  it.each([
    { access: "tunnel", phone: "ios" },
    { access: "tailscale", phone: "android" },
    { access: "public-url", publicUrl: "https://old-proxy.example.test", phone: "ios" },
  ])("pairs the phone app at the running server's own address instead of saved $access access", async (saved) => {
    mocks.readCliStartup.mockReturnValue(saved);
    expect(await runPair(options)).toBe(0);
    expectPhonePairing(advertisedOrigin);
    expect(mocks.readCliStartup).not.toHaveBeenCalled();
  });

  it("hands the server an explicit --public-url to check and use", async () => {
    expect(await runPair({ ...options, publicUrl: explicitOrigin })).toBe(0);
    expectPhonePairing(explicitOrigin);
  });

  it("uses saved access when the server advertises no address", async () => {
    publicUrl = null;
    mocks.readCliStartup.mockReturnValue({ access: "public-url", publicUrl: "https://saved.example.test", phone: "ios" });
    expect(await runPair(options)).toBe(0);
    expectPhonePairing("https://saved.example.test");
  });

  it("says plainly that a phone cannot pair, and makes no code, when nothing can reach the server", async () => {
    publicUrl = null;
    mocks.readCliStartup.mockReturnValue({ access: "tailscale", phone: "ios" });
    mocks.tailscaleStatus.mockResolvedValue({ status: { dnsName: null } });
    mobilePairing = () => Response.json({ error: "A phone cannot reach this workspace yet", code: "unreachable" }, { status: 409 });
    expect(await runPair(options)).toBe(1);
    expect(posts().map((one) => one.url)).toEqual(["/api/mobile/pairing"]);
    expect(transcript()).toContain("could not get notifications");
    expect(transcript()).toContain("--public-url https://your.host");
  });

  it("pairs over the link relay on a server with no public address", async () => {
    publicUrl = null;
    mocks.readCliStartup.mockReturnValue({ access: "local" });
    mobilePairing = () => Response.json({ link: "duskbot://link?v=1&g=grant", code: typed, expiresAt: Date.now() + 300_000, payload: { via: [{ kind: "relay", base: "https://link.dusk.bot" }] } });
    expect(await runPair(options)).toBe(0);
    expectPhonePairing();
  });

  it.each([2, new SetupCancelled()])("does not mint a code when phone selection is cancelled (%s)", async (cancel) => {
    if (cancel instanceof Error) mocks.ui.choose.mockRejectedValue(cancel);
    else mocks.ui.choose.mockResolvedValue(cancel);
    expect(await runPair(options)).toBe(cancel instanceof Error ? 130 : 0);
    expect(posts()).toHaveLength(0);
  });
});

// `duskbot pair --label iPhone --phone ios --public-url https://dusk.example` on a server with no link service must pair
// the phone app, never make a browser sign-in the phone takes as a pairing that push cannot use
describe("duskbot pair --phone", () => {
  beforeEach(() => {
    for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
    publicUrl = null;
  });

  it("makes a real phone pairing at the --public-url address, never a sign-in code", async () => {
    expect(await runPair({ ...options, label: "iPhone", phone: "ios", publicUrl: explicitOrigin })).toBe(0);
    expect(posts()).toEqual([{ url: "/api/mobile/pairing", body: { label: "iPhone", origin: explicitOrigin } }]);
    expect(transcript()).toContain(typed);
    expect(transcript()).toContain("iPhone (APNs)");
    expect(transcript()).not.toContain("Android (FCM)");
    expect(transcript()).not.toContain("duskbot://pair?");
  });

  it("names the Android app's scanner and FCM for --phone android", async () => {
    expect(await runPair({ ...options, phone: "android", publicUrl: explicitOrigin })).toBe(0);
    expect(posts()[0]!.body).toMatchObject({ label: "Android" });
    expect(transcript()).toContain("Scan this in the dusk bot app");
    expect(transcript()).toContain("Android (FCM)");
  });

  it("says the address is not this server when the server could not confirm it", async () => {
    mobilePairing = () => Response.json({ error: "no", code: "origin_unverified" }, { status: 409 });
    expect(await runPair({ ...options, phone: "ios", publicUrl: explicitOrigin })).toBe(1);
    expect(transcript()).toContain(`${explicitOrigin} does not answer as this server`);
    expect(posts().map((one) => one.url)).toEqual(["/api/mobile/pairing"]);
  });

  it("tells an old server's owner to update instead of printing a code a phone cannot use", async () => {
    mobilePairing = () => Response.json({ error: "not found" }, { status: 404 });
    expect(await runPair({ ...options, phone: "ios" })).toBe(1);
    expect(transcript()).toContain("too old to pair the phone app");
    expect(posts().map((one) => one.url)).toEqual(["/api/mobile/pairing"]);
  });
});

describe("duskbot pair without --phone", () => {
  beforeEach(() => {
    for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  });

  it("signs in a web browser and says how to pair the phone app instead", async () => {
    mobilePairing = () => Response.json({ error: "A phone cannot reach this workspace yet", code: "unreachable" }, { status: 409 });
    expect(await runPair({ ...options, label: "Laptop" })).toBe(0);
    expect(transcript()).toContain(`pairing code:  ${code}`);
    expect(transcript()).toContain("duskbot pair --phone ios");
    expect(transcript()).not.toContain("phone app:");
  });

  it("prints the phone app's relay pairing when the server has the link service", async () => {
    mobilePairing = () => Response.json({ link: "duskbot://link?v=1&g=grant", code: typed, expiresAt: Date.now() + 300_000, payload: { via: [{ kind: "relay", base: "https://link.dusk.bot" }] } });
    expect(await runPair({ ...options, label: "Pixel" })).toBe(0);
    expect(transcript()).toContain(typed);
    expect(posts().map((one) => one.url)).toEqual(["/api/mobile/pairing"]);
  });
});
