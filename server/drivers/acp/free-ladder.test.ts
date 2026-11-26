import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalog } from "../../contracts.ts";
import {
  advertisedVariant, coolFreeRung, FREE_LIMIT_TRIES, FREE_RUNG_COOL_MS, FREE_RUNG_LIMIT_MS, FREE_RUNG_WARM_MS, freeFailure, freeLadder, freeLadderLimited, freeLimitBucket,
  freeOneShot, freeRungCooling, freeRungLimited, nextFreeRung, probeFreeLadder, resetFreeLadder, spannedSuspend, warmFreeModel, warmFreeRung,
} from "./free-ladder.ts";

const low = [{ id: "low", label: "Low" }, { id: "high", label: "High" }];
const models: ModelCatalog = {
  default: "opencode/big-pickle",
  options: [
    { id: "opencode/big-pickle", label: "Big Pickle" },
    { id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek", variants: low },
    { id: "opencode/inkling-2-small-free", label: "Inkling", variants: [{ id: "none", label: "None" }, { id: "minimal", label: "Minimal" }] },
    { id: "opencode/mimo-v2.6-flash-free", label: "MiMo" },
  ],
};
const order = models.options.map((option) => option.id);

describe("free model ladder", () => {
  beforeEach(() => resetFreeLadder());

  it("starts on the turn's own model, then the other free models at their lighter setting", () => {
    expect(freeLadder({ model: "opencode/big-pickle", variant: "high" }, order, models, 0)).toEqual([
      { model: "opencode/big-pickle", variant: "high" },
      { model: "opencode/deepseek-v4.1-flash-free", variant: "low" },
      { model: "opencode/inkling-2-small-free", variant: "minimal" },
      { model: "opencode/mimo-v2.6-flash-free" },
    ]);
  });

  it("puts a cooling rung last until its cool-down ends", () => {
    coolFreeRung("opencode/big-pickle", "busy", 1_000);
    expect(freeRungCooling("opencode/big-pickle", 1_000)).toBe(true);
    expect(freeLadder({ model: "opencode/big-pickle" }, order, models, 2_000).map((rung) => rung.model)).toEqual([
      "opencode/deepseek-v4.1-flash-free", "opencode/inkling-2-small-free", "opencode/mimo-v2.6-flash-free", "opencode/big-pickle",
    ]);
    const later = 1_000 + FREE_RUNG_COOL_MS;
    expect(freeRungCooling("opencode/big-pickle", later)).toBe(false);
    expect(freeLadder({ model: "opencode/big-pickle" }, order, models, later)[0]!.model).toBe("opencode/big-pickle");
  });

  it("keeps every rung when all are cooling, the soonest ready first, so a turn always has one to try", () => {
    for (const [index, model] of order.entries()) coolFreeRung(model, "timeout", 10 - index);
    expect(freeLadder({ model: "opencode/big-pickle" }, order, models, 20).map((rung) => rung.model)).toEqual([...order].reverse());
  });

  it("tries the model that last answered right after the turn's own", () => {
    warmFreeRung({ model: "opencode/mimo-v2.6-flash-free" }, 0);
    expect(freeLadder({ model: "opencode/big-pickle" }, order, models, 1).map((rung) => rung.model)[1]).toBe("opencode/mimo-v2.6-flash-free");
    expect(warmFreeModel(FREE_RUNG_WARM_MS + 1)).toBeNull();
  });

  it("reads what went wrong from OpenCode's own words", () => {
    expect(freeFailure("Free usage limit reached. Free models work in OpenCode")).toBe("pool_limit");
    expect(freeFailure("Rate limit exceeded. Please try again later.")).toBe("rate_limited");
    expect(freeFailure("429 Too Many Requests")).toBe("rate_limited");
    expect(freeFailure("Upstream request failed: Model is unavailable.")).toBe("busy");
    expect(freeFailure("503 Service Unavailable")).toBe("busy");
    expect(freeFailure("The model is overloaded")).toBe("busy");
    expect(freeFailure("background call timed out")).toBe("timeout");
    expect(freeFailure("", { empty: true })).toBe("empty");
  });
});

describe("free model start-up probe", () => {
  beforeEach(() => resetFreeLadder());
  const ladder = order.map((model) => ({ model }));

  it("stops at the first rung that answers, cooling the ones that did not", async () => {
    const tried: string[] = [];
    const picked = await probeFreeLadder(ladder, async ({ model }) => {
      tried.push(model);
      if (model === "opencode/big-pickle") throw new Error("OpenCode background call timed out");
    }, () => {});
    expect(tried).toEqual(["opencode/big-pickle", "opencode/deepseek-v4.1-flash-free"]);
    expect(picked).toEqual({ model: "opencode/deepseek-v4.1-flash-free" });
    expect(freeRungCooling("opencode/big-pickle")).toBe(true);
    expect(warmFreeModel()).toEqual({ model: "opencode/deepseek-v4.1-flash-free" });
  });

  it("never cools a model whose probe timed out across a sleep, and asks it once more after", async () => {
    let wall = 1_000_000;
    let mono = 0;
    const tried: string[] = [];
    const events: Array<{ ok: boolean; suspended?: boolean }> = [];
    const picked = await probeFreeLadder(ladder, async ({ model }) => {
      tried.push(model);
      if (tried.length === 1) {
        // the screen locked: 589 s on the wall clock, 15 s on the monotonic one, then the probe's timer fired
        wall += 589_000;
        mono += 15_000;
        throw new Error("OpenCode background call timed out");
      }
      wall += 900;
      mono += 900;
    }, (event) => events.push(event), { now: () => wall, monotonic: () => mono, limitMs: 15_000 });
    expect(tried).toEqual(["opencode/big-pickle", "opencode/big-pickle"]);
    expect(picked).toEqual({ model: "opencode/big-pickle" });
    expect(freeRungCooling("opencode/big-pickle", wall)).toBe(false);
    expect(events).toEqual([expect.objectContaining({ ok: false, suspended: true }), expect.objectContaining({ ok: true })]);
  });

  it("still cools a model that timed out while the computer stayed awake", async () => {
    let wall = 0;
    let mono = 0;
    await probeFreeLadder(ladder.slice(0, 1), async () => { wall += 15_200; mono += 15_200; throw new Error("timed out"); }, () => {},
      { now: () => wall, monotonic: () => mono, limitMs: 15_000 });
    expect(freeRungCooling("opencode/big-pickle", wall)).toBe(true);
  });

  it("tells a suspend from a slow call by the two clocks or a far-late timer", () => {
    expect(spannedSuspend({ wall: 0, mono: 0 }, { wall: 589_000, mono: 15_000 }, 15_000)).toBe(true);
    expect(spannedSuspend({ wall: 0, mono: 0 }, { wall: 589_000, mono: 589_000 }, 15_000)).toBe(true);
    expect(spannedSuspend({ wall: 0, mono: 0 }, { wall: 15_300, mono: 15_300 }, 15_000)).toBe(false);
  });

  it("stops at the free usage limit every free model shares, and at its rung cap", async () => {
    let calls = 0;
    expect(await probeFreeLadder(ladder, async () => { calls += 1; throw new Error("Free usage limit reached."); }, () => {})).toBeNull();
    expect(calls).toBe(1);
    resetFreeLadder();
    calls = 0;
    expect(await probeFreeLadder(ladder, async () => { calls += 1; throw new Error("503"); }, () => {}, { maxRungs: 2 })).toBeNull();
    expect(calls).toBe(2);
  });
});

describe("free usage limit", () => {
  beforeEach(() => resetFreeLadder());
  const rungs = (...ids: string[]) => ids.map((model) => ({ model }));

  it("keys Zen's per-model count on the first two letters of the Zen id", () => {
    expect(freeLimitBucket("opencode/deepseek-v4.1-flash-free")).toBe("de");
    expect(freeLimitBucket("opencode/nemotron-3.5-lightning-free")).toBe(freeLimitBucket("opencode/nemotron-3.5-super-vl-free"));
  });

  it("skips a limited model for half an hour, not the five minutes of a busy one", () => {
    coolFreeRung("opencode/beam-free", "pool_limit", 0);
    expect(freeRungLimited("opencode/beam-free", FREE_RUNG_COOL_MS + 1)).toBe(true);
    expect(freeRungLimited("opencode/beam-free", FREE_RUNG_LIMIT_MS + 1)).toBe(false);
    coolFreeRung("opencode/mimo-v2.6-flash-free", "busy", 0);
    expect(freeRungLimited("opencode/mimo-v2.6-flash-free", 1)).toBe(false);
  });

  it("moves on after the limit only to a model counted apart that is not known to be at the limit", () => {
    const ladder = rungs("opencode/beam-free", "opencode/beta-free", "opencode/iceman-free", "opencode/mimo-v2.6-flash-free");
    coolFreeRung("opencode/beam-free", "pool_limit", 0);
    coolFreeRung("opencode/iceman-free", "pool_limit", 0);
    expect(nextFreeRung(ladder, ["opencode/beam-free"], 1)?.model).toBe("opencode/mimo-v2.6-flash-free");
    expect(nextFreeRung(ladder, ["opencode/beam-free", "opencode/mimo-v2.6-flash-free"], 1)).toBeUndefined();
  });

  it("tries at most a few models after the limit", () => {
    const ids = ["a", "b", "c", "d", "e", "f"].map((letter) => `opencode/${letter}${letter}-free`);
    const tried = ids.slice(0, FREE_LIMIT_TRIES);
    for (const model of tried) coolFreeRung(model, "pool_limit", 0);
    const last = nextFreeRung(rungs(...ids), tried, 1)!.model;
    expect(last).toBe(ids[FREE_LIMIT_TRIES]);
    coolFreeRung(last, "pool_limit", 0);
    expect(nextFreeRung(rungs(...ids), [...tried, last], 1)).toBeUndefined();
  });

  it("skips models at the limit after another failure too", () => {
    coolFreeRung("opencode/beam-free", "pool_limit", 0);
    coolFreeRung("opencode/iceman-free", "timeout", 0);
    expect(nextFreeRung(rungs("opencode/iceman-free", "opencode/beam-free", "opencode/mimo-free"), ["opencode/iceman-free"], 1)?.model).toBe("opencode/mimo-free");
  });

  it("makes no call at all for background work while every free model is at the limit", async () => {
    const ladder = rungs("opencode/beam-free", "opencode/mimo-free");
    for (const { model } of ladder) coolFreeRung(model, "pool_limit");
    expect(freeLadderLimited(ladder)).toBe(true);
    const run = vi.fn(async () => "ok");
    await expect(freeOneShot(ladder, run, undefined, "OpenCode")).rejects.toThrow(/free usage limit/);
    await expect(probeFreeLadder(ladder, run, () => {})).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("advertised variant", () => {
  const noneHighDefault = [{ id: "none" }, { id: "high" }, { id: "default" }];

  it("keeps a variant the model advertises", () => {
    expect(advertisedVariant(noneHighDefault, "high")).toBe("high");
  });

  it("falls back to the model's default when the configured variant is not advertised", () => {
    expect(advertisedVariant(noneHighDefault, "low")).toBe("default");
  });

  it("falls back to none when the model has no default either", () => {
    expect(advertisedVariant([{ id: "none" }, { id: "high" }], "low")).toBeUndefined();
  });

  it("leaves the variant alone when the model has no variant list", () => {
    expect(advertisedVariant(undefined, "low")).toBe("low");
  });
});
