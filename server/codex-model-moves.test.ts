import { describe, expect, it, vi } from "vitest";

import type { ModelCatalog } from "./contracts.ts";
import { moveCodexModels } from "./codex-model-moves.ts";
import { codexListedModel, encodeCodexSelection } from "./drivers/codex-catalog.ts";
import type { BotRecord } from "./store.ts";

// Codex whose config.toml sends its models through CLIProxyAPI: GPT-5.5 is listed only under the proxy.
const proxied: ModelCatalog = {
  default: encodeCodexSelection("cpa", "gpt-5.5"),
  options: [
    { id: "gpt-6-sol", label: "GPT-6 Sol" },
    { id: encodeCodexSelection("cpa", "gpt-5.5"), label: "GPT-5.5 (CLIProxyAPI)", custom: true },
    { id: encodeCodexSelection("cpa", "gpt-5.4"), label: "GPT-5.4 (CLIProxyAPI)", custom: true },
  ],
};

describe("codexListedModel", () => {
  it("moves a ChatGPT row the proxy now serves to the proxy's row of the same model", () => {
    expect(codexListedModel(proxied, "gpt-5.4")).toBe(encodeCodexSelection("cpa", "gpt-5.4"));
  });
  it("moves a ChatGPT row the proxy does not serve to the default, the proxy's own pick", () => {
    expect(codexListedModel(proxied, "gpt-5.3-codex")).toBe(encodeCodexSelection("cpa", "gpt-5.5"));
  });
  it("leaves a listed model, a proxy row, and every model of a Codex on its ChatGPT sign-in as they are", () => {
    expect(codexListedModel(proxied, "gpt-6-sol")).toBeUndefined();
    expect(codexListedModel(proxied, encodeCodexSelection("omlx", "gone"))).toBeUndefined();
    expect(codexListedModel({ default: "gpt-6-sol", options: [{ id: "gpt-6-sol", label: "GPT-6 Sol" }] }, "gpt-5.4")).toBeUndefined();
  });
});

describe("moveCodexModels", () => {
  it("moves the bot and its conversations on the hidden row, and nothing on another engine", () => {
    const bot = {
      id: "kai", modelSelection: { instanceId: "codex", model: "gpt-5.5", effort: "high" },
      tasks: [
        { threadId: "t1", modelSelection: { instanceId: "codex", model: "gpt-5.4" } },
        { threadId: "t2" },
        { threadId: "t3", modelSelection: { instanceId: "claude", model: "gpt-5.4" } },
      ],
    } as unknown as BotRecord;
    const store = { bots: [bot], patchBot: vi.fn(), patchTask: vi.fn() };
    const moved = moveCodexModels(store, [
      { instanceId: "codex", driverKind: "codex", models: proxied },
      { instanceId: "claude", driverKind: "claudeAgent", models: { default: "x", options: [] } },
    ]);
    expect(moved).toBe(2);
    expect(store.patchBot).toHaveBeenCalledWith("kai", { modelSelection: { instanceId: "codex", model: encodeCodexSelection("cpa", "gpt-5.5"), effort: "high" } });
    expect(store.patchTask).toHaveBeenCalledTimes(1);
    expect(store.patchTask).toHaveBeenCalledWith("kai", "t1", { modelSelection: { instanceId: "codex", model: encodeCodexSelection("cpa", "gpt-5.4") } });
  });
});
