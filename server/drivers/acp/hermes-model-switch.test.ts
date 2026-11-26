// A Hermes chat must run the model picked now, on the next turn, whether the switch happened in dusk bot's
// picker or in Hermes' own config.yaml, in a warm process or after a restart that resumes the session.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../../contracts.ts";
import { recordEvents } from "../../testing/events.ts";
import { HERMES_CONFIG_MODEL_ID, HermesAgentDriver } from "./hermes.ts";

const FAKE_HERMES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-hermes-acp.ts");

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hermesHome(model: string, servable: string[]) {
  const home = mkdtempSync(join(tmpdir(), "dusk-hermes-switch-"));
  homes.push(home);
  const dir = join(home, ".hermes");
  mkdirSync(dir, { recursive: true });
  const setConfig = (next: string) => writeFileSync(join(dir, "config.yaml"), `model:\n  provider: openrouter\n  default: ${next}\n`);
  setConfig(model);
  writeFileSync(join(dir, ".env"), "OPENROUTER_API_KEY=sk-or-test\n");
  const log = join(home, "rpc.jsonl");
  const environment = { HOME: home, USERPROFILE: home, HERMES_HOME: dir, FAKE_HERMES_SERVABLE: servable.join(","), FAKE_HERMES_LOG: log };
  return { environment, setConfig, setModels: (models: string[]) => { environment.FAKE_HERMES_SERVABLE = models.join(","); } };
}

async function start(environment: Record<string, string>) {
  const instance = await HermesAgentDriver.create({
    instanceId: "hermes",
    displayName: "Hermes",
    environment: { ...environment },
    enabled: true,
    config: { cli: FAKE_HERMES, fullAuto: true },
  });
  const recorder = recordEvents(instance.adapter);
  let turns = 0;
  const turn = async (input: { model?: string; resumeCursor?: string }) => {
    const before = recorder.events.length;
    await instance.adapter.sendTurn({ threadId: "t-hermes", text: `turn ${++turns}`, ...input });
    await recorder.until((e) => e.type === "turn.completed" && recorder.events.indexOf(e) >= before, 20_000);
    const mine = recorder.events.slice(before);
    const done = mine.find((e) => e.type === "turn.completed") as Extract<RuntimeEvent, { type: "turn.completed" }>;
    const text = JSON.stringify(mine.filter((e) => e.type !== "runtime.notice"));
    const started = mine.find((e) => e.type === "session.started") as any;
    const notices = mine.filter((e) => e.type === "runtime.notice").map((e) => (e as any).message as string);
    return { done, text, sessionId: started?.sessionId as string | undefined, notices };
  };
  return { instance, turn };
}

describe("Hermes model switches take effect on the next turn", () => {
  it("follows a model switched in Hermes' config.yaml, in the warm process and after a restart", async () => {
    const hermes = hermesHome("old/model", ["openrouter:old/model"]);
    const first = await start(hermes.environment);
    let cursor: string | undefined;
    try {
      const one = await first.turn({ model: HERMES_CONFIG_MODEL_ID });
      expect(one.done).toMatchObject({ ok: true });
      expect(one.text).toContain("ran on openrouter:old/model");
      cursor = one.sessionId;
      expect(cursor).toBeTruthy();

      // `hermes model` picks a new default and the old one is gone from the provider.
      hermes.setConfig("new/model");
      hermes.setModels(["openrouter:new/model"]);
    } finally {
      await first.instance.dispose();
    }
    // the fake reads FAKE_HERMES_SERVABLE at spawn, so the new list applies from the next process on
    const second = await start(hermes.environment);
    try {
      const two = await second.turn({ model: HERMES_CONFIG_MODEL_ID, resumeCursor: cursor });
      expect(two.done).toMatchObject({ ok: true });
      expect(two.text).toContain("ran on openrouter:new/model");
      expect(two.notices).toEqual([]);
    } finally {
      await second.instance.dispose();
    }
  });

  it("follows a config.yaml switch inside a warm pooled session", async () => {
    const hermes = hermesHome("old/model", ["openrouter:old/model", "openrouter:new/model"]);
    const run = await start(hermes.environment);
    try {
      const one = await run.turn({ model: HERMES_CONFIG_MODEL_ID });
      expect(one.text).toContain("ran on openrouter:old/model");
      hermes.setConfig("new/model");
      const two = await run.turn({ model: HERMES_CONFIG_MODEL_ID, resumeCursor: one.sessionId });
      expect(two.done).toMatchObject({ ok: true });
      expect(two.text).toContain("ran on openrouter:new/model");
    } finally {
      await run.instance.dispose();
    }
  });

  it("switching the picker back to Hermes' default leaves the earlier pick", async () => {
    const hermes = hermesHome("cfg/model", ["openrouter:cfg/model", "openrouter:picked/model"]);
    const run = await start(hermes.environment);
    try {
      const one = await run.turn({ model: "openrouter:picked/model" });
      expect(one.text).toContain("ran on openrouter:picked/model");
      const two = await run.turn({ model: HERMES_CONFIG_MODEL_ID, resumeCursor: one.sessionId });
      expect(two.done).toMatchObject({ ok: true });
      expect(two.text).toContain("ran on openrouter:cfg/model");
    } finally {
      await run.instance.dispose();
    }
  });

  it("a picked model Hermes can no longer serve falls back to the config model, saying so once", async () => {
    const hermes = hermesHome("cfg/model", ["openrouter:cfg/model"]);
    const run = await start(hermes.environment);
    try {
      const one = await run.turn({ model: "openrouter:gone/model" });
      expect(one.done).toMatchObject({ ok: true });
      expect(one.text).toContain("ran on openrouter:cfg/model");
      expect(one.notices).toEqual(["Hermes can't run gone/model anymore, so this chat uses cfg/model. Pick another model to stop seeing this."]);
      const two = await run.turn({ model: "openrouter:gone/model", resumeCursor: one.sessionId });
      expect(two.done).toMatchObject({ ok: true });
      expect(two.text).toContain("ran on openrouter:cfg/model");
      expect(two.notices).toEqual([]);
      const setModels = readFileSync(join(hermes.environment.HOME, "rpc.jsonl"), "utf8").trim().split("\n")
        .map((line) => JSON.parse(line)).filter((row) => row.method === "session/set_model");
      // turn 2 retries the pick once, then stays on the working model without another fallback switch
      expect(setModels.map((row) => row.params.modelId)).toEqual(["openrouter:gone/model", "openrouter:gone/model"]);
    } finally {
      await run.instance.dispose();
    }
  });
});
