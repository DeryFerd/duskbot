import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { dataFilePath, fill, plannedShots, readRecipe, readSteps, type CaptureStep } from "./recipe.ts";

const PAIR: CaptureStep[] = [
  { type: { name: "Message Pepper", text: "hello" } },
  { press: "Enter" },
  { settle: 60 },
  { shot: true },
  { shot: "f01-sent", only: "after" },
  { click: "Retry", only: "after" },
  { shot: "retried", only: "after" },
];

describe("a capture recipe", () => {
  it("reads the entry, the engine's turn, the colour, the window and the steps", () => {
    const recipe = readRecipe({
      about: "a pair", color: "teal", reducedMotion: false, width: 390, height: 844, scale: 2,
      script: [{ text: "Done." }], toolCalls: [{ name: "Bash" }], steps: PAIR,
    });
    expect(recipe).toMatchObject({ entry: "threads", color: "teal", reducedMotion: false, width: 390, height: 844, scale: 2 });
    expect(recipe.steps).toEqual(PAIR);
    expect(recipe.script).toEqual([{ text: "Done." }]);
    expect(recipe.toolCalls).toEqual([{ name: "Bash" }]);
  });

  it("leaves what a recipe does not pin to the capture's defaults", () => {
    expect(readRecipe({ steps: [] })).toEqual({ entry: "threads", steps: [] });
  });

  it("refuses a field or a step it does not know, naming it", () => {
    expect(() => readRecipe({ steps: [], colour: "teal" })).toThrow(/unknown recipe field colour/);
    expect(() => readRecipe({ steps: [], entry: "inbox" })).toThrow(/entry must be one of/);
    expect(() => readRecipe({ steps: [], width: 100 })).toThrow(/width/);
    expect(() => readSteps([{ click: "Search" }, { tap: "Search" }])).toThrow(/step 2: unknown step tap/);
    expect(() => readSteps([{ click: "Search", press: "Enter" }])).toThrow(/step 1 must hold exactly one of/);
    expect(() => readSteps([{ shot: "Not A Word" }])).toThrow(/step 1: shot has the wrong value/);
    expect(() => readSteps([{ shot: true, only: "After" }])).toThrow(/step 1: only must be a state/);
    expect(() => readSteps({ click: "Search" })).toThrow(/JSON array/);
  });

  it("gives each state its own files when a pair is captured together", () => {
    const shots = plannedShots(PAIR, ["before", "after"], "pr-37");
    expect(shots.get("before")).toEqual(["pr-37.before.raw.png"]);
    expect(shots.get("after")).toEqual(["pr-37.after.raw.png", "pr-37.f01-sent.raw.png", "pr-37.retried.raw.png"]);
  });

  it("takes one shot at the end for a state that has no shot step", () => {
    const steps: CaptureStep[] = [{ click: "Search" }, { shot: "f01-open", only: "after" }];
    expect(plannedShots(steps, ["before", "after"], "search").get("before")).toEqual(["search.before.raw.png"]);
    expect(plannedShots([], ["after"], "chat").get("after")).toEqual(["chat.after.raw.png"]);
  });

  it("refuses a named shot two states would both write", () => {
    expect(() => plannedShots([{ shot: "f01-open" }], ["before", "after"], "chat")).toThrow(/before and after both write chat\.f01-open\.raw\.png/);
    expect(() => plannedShots([{ shot: "open" }, { shot: "open" }], ["after"], "chat")).toThrow(/after writes chat\.open\.raw\.png/);
    expect(plannedShots([{ shot: "f01-open" }], ["after"], "chat").get("after")).toEqual(["chat.f01-open.raw.png"]);
  });

  it("fills the fixture's bot and the time into the rows it appends, and nothing else", () => {
    const filled = fill(
      { file: "usage/{month}.jsonl", rows: [{ botId: "{botId}", at: "{now}", cost: 0.01, trigger: { kind: "upkeep", botId: "{botId}" }, note: "{other} {" }] },
      { botId: "b1", now: "2026-11-21T10:00:00.000Z", month: "2026-11" },
    );
    expect(filled).toEqual({
      file: "usage/2026-11.jsonl",
      rows: [{ botId: "b1", at: "2026-11-21T10:00:00.000Z", cost: 0.01, trigger: { kind: "upkeep", botId: "b1" }, note: "{other} {" }],
    });
  });

  it("writes rows only inside the fixture's data directory", () => {
    expect(dataFilePath("/tmp/fixture", "usage/2026-11.jsonl")).toBe(resolve("/tmp/fixture", "usage", "2026-11.jsonl"));
    expect(() => dataFilePath("/tmp/fixture", "../other/usage.jsonl")).toThrow(/only inside the fixture's data directory/);
    expect(() => dataFilePath("/tmp/fixture", "/etc/hosts")).toThrow(/only inside the fixture's data directory/);
    expect(() => dataFilePath("/tmp/fixture", ".")).toThrow(/only inside the fixture's data directory/);
  });
});
