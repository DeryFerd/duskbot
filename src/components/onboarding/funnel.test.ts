import { describe, expect, it } from "vitest";
import { AI_TILES, accountDue, aiName, aiTiles, autoConnects, freeModel, funnelSteps, nextStep, previousStep } from "./funnel";

const ai = (instanceId: string, driverKind: string, ready = false, extra: Record<string, unknown> = {}) => ({
  instanceId, driverKind, displayName: instanceId, access: "subscription", snapshot: { state: ready ? "available" : "unavailable", ...extra },
});
const ready = (instance: { snapshot: { state: string } }) => instance.snapshot.state === "available";

describe("the funnel's steps", () => {
  it("is two screens on this Mac for someone signed in: the hello, then the one AI choice", () => {
    const steps = funnelSteps({ account: false, desktop: true });
    expect(steps).toEqual(["welcome", "ai"]);
    expect(nextStep(steps, "welcome")).toBe("ai");
    expect(nextStep(steps, "ai"), "the chat comes after it").toBeNull();
    expect(previousStep(steps, "ai")).toBe("welcome");
    expect(funnelSteps({ account: false, desktop: false })).toEqual(["welcome", "ai"]);
  });

  it("never shows where bots live, bringing things in, the phone or the Mac's permissions as a step", () => {
    const steps = funnelSteps({ account: false, desktop: true, path: "mac" });
    for (const gone of ["place", "bring", "phone", "permissions", "checkout", "making"]) expect(steps).not.toContain(gone);
  });

  it("goes from the sign-in straight to the chat when an AI of the person's own is signed in here, except on the way to dusk cloud", () => {
    expect(funnelSteps({ account: true, desktop: true, aiFound: true })).toEqual(["welcome", "account"]);
    expect(nextStep(["welcome", "account"], "account"), "the chat").toBeNull();
    expect(funnelSteps({ account: false, desktop: true, aiFound: true })).toEqual(["welcome"]);
    expect(funnelSteps({ account: true, desktop: true, aiFound: true, path: "cloud" })).toEqual(["welcome", "account", "checkout", "ai", "making"]);
  });

  it("always has the grid's eight AIs, in the Connect an AI dialog's order", () => {
    expect(AI_TILES.map((tile) => tile.id)).toEqual(["chatgpt", "claude", "grok", "antigravity", "cursor", "copilot", "openrouter", "local"]);
  });

  it("asks to sign in right after Get started, before the AI choice, for anyone not signed in yet", () => {
    const steps = funnelSteps({ account: true, desktop: true });
    expect(steps).toEqual(["welcome", "account", "ai"]);
    expect(nextStep(steps, "welcome")).toBe("account");
    expect(nextStep(steps, "account")).toBe("ai");
    expect(funnelSteps({ account: true, desktop: true, path: "cloud" }), "dusk cloud's checkout and making come after it").toEqual(["welcome", "account", "checkout", "ai", "making"]);
  });

  it("decides the sign-in step from the account: there until it is known to be signed in, never on a replay or where this window can't sign in", () => {
    expect(accountDue({ canSignIn: true, signedIn: undefined }), "not read yet: kept, so Get started never skips past it").toBe(true);
    expect(accountDue({ canSignIn: true, signedIn: false })).toBe(true);
    expect(accountDue({ canSignIn: true, signedIn: true }), "a handoff from the website or an account from before").toBe(false);
    expect(accountDue({ canSignIn: false, signedIn: false }), "a browser, a server's own page").toBe(false);
    expect(accountDue({ canSignIn: true, signedIn: false, replay: true }), "the welcome again from Settings").toBe(false);
  });

  it("skips the hello on a server opened from the desktop app, where the person already met dusk bot", () => {
    expect(funnelSteps({ account: false, desktop: false, hello: false })).toEqual(["ai"]);
  });

  it("on a cloud the desktop app set up: the hello and that computer's bots when it has some, never a second AI step", () => {
    expect(funnelSteps({ account: false, desktop: false, aiAsked: true })).toEqual(["welcome"]);
    expect(funnelSteps({ account: false, desktop: false, cloudBring: true, aiAsked: true })).toEqual(["welcome", "bring"]);
  });

  it("a run already on its way to dusk cloud keeps its checkout and the cloud being made, never back to a purchase that is done", () => {
    const steps = funnelSteps({ account: false, desktop: true, path: "cloud" });
    expect(steps).toEqual(["welcome", "checkout", "ai", "making"]);
    expect(nextStep(steps, "checkout")).toBe("ai");
    expect(nextStep(steps, "ai")).toBe("making");
    expect(nextStep(steps, "making")).toBeNull();
    expect(previousStep(steps, "ai", { paid: true })).toBeNull();
    expect(funnelSteps({ account: false, desktop: true, path: "cloud", paid: true }), "an account that already owns a cloud").toEqual(["welcome", "ai", "making"]);
    expect(funnelSteps({ account: false, desktop: false, path: "cloud" }), "only on the desktop app").toEqual(["welcome", "ai"]);
  });
});

describe("the AI grid", () => {
  it("names each AI as people know it, in a fixed order, with only the ones this app can connect", () => {
    const tiles = aiTiles([ai("claude", "claudeAgent"), ai("chatgpt", "codex"), ai("antigravity", "antigravityAgent"), ai("openrouter", "openai-compat")], ready);
    expect(tiles.map((tile) => [tile.id, tile.label, tile.instance.instanceId])).toEqual([
      ["chatgpt", "ChatGPT", "chatgpt"], ["claude", "Claude", "claude"], ["antigravity", "Antigravity", "antigravity"], ["openrouter", "OpenRouter", "openrouter"],
    ]);
    expect(aiName({ instanceId: "chatgpt", driverKind: "codex", displayName: "ChatGPT plan" })).toBe("ChatGPT");
    expect(aiName({ instanceId: "kimi", driverKind: "kimiAgent", displayName: "Kimi" })).toBe("Kimi");
  });

  it("lets a signed-in one stand for its tile", () => {
    const tiles = aiTiles([ai("chatgpt", "codex"), ai("codex", "codex", true)], ready);
    expect(tiles[0]!.instance.instanceId).toBe("codex");
  });

  it("never offers an AI whose saved driver this build lacks, falling back to one of its kind it does know", () => {
    const unknown = (instanceId: string) => ({ ...ai(instanceId, "not-a-real-driver"), unknownDriver: true as const });
    const tiles = aiTiles([ai("claude", "claudeAgent"), unknown("openaiCompat"), unknown("cursor"), unknown("chatgpt"), ai("codex", "codex")], ready);
    expect(tiles.map((tile) => [tile.id, tile.instance.instanceId])).toEqual([["chatgpt", "codex"], ["claude", "claude"]]);
    expect(tiles[0]!.candidates.map((candidate) => candidate.instanceId)).toEqual(["codex"]);
  });

  it("offers the free model only when it is ready", () => {
    expect(freeModel([ai("opencodeGo", "opencodeGo", true, { freeFallback: true })], ready)?.instanceId).toBe("opencodeGo");
    expect(freeModel([ai("opencodeGo", "opencodeGo", false, { freeFallback: true })], ready)).toBeUndefined();
  });
});

describe("the AIs the first run connects by itself", () => {
  const found = { found: true as const };
  it("connects every ready AI the server only found here, never one chosen already, signed out or silent on its test", () => {
    const claude = { ...ai("claude", "claudeAgent", true), ...found };
    const codex = { ...ai("codex", "codex", true), ...found };
    const grok = ai("grok", "grokAgent", true);
    const cursor = { ...ai("cursor", "cursorAgent", false), ...found };
    const all = [claude, codex, grok, cursor];
    expect(autoConnects(all, ready).map((one) => one.instanceId)).toEqual(["claude", "codex"]);
    expect(autoConnects(all, ready, ["codex"]).map((one) => one.instanceId), "its test went unanswered").toEqual(["claude"]);
  });
});
