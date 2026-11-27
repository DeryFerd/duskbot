import { describe, expect, it } from "vitest";
import { botVoice, characterPrompt, CHARACTER_PROMPT, DEFAULT_SOUL_PROMPT, WORK_CHARACTER_PROMPT, WORK_DEFAULT_SOUL_PROMPT } from "./character.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { beatPrompt } from "./turn-beats.ts";
import { buildLearnPrompt, AUTHORING_STANDARDS } from "./skill-learn.ts";

describe("bot voice", () => {
  it("reads a work role from the name, title, description or setup", () => {
    expect(botVoice({ name: "Forge", title: "Ops and CI", description: "Keeps an eye on deploys and on-call." })).toBe("work");
    expect(botVoice({ name: "Ops" })).toBe("work");
    expect(botVoice({ name: "Ledger", soul: "You keep the invoices, runway and burn straight." })).toBe("work");
    expect(botVoice({ name: "Coder" })).toBe("work");
  });

  it("reads a companion role, and tone words in the setup win over the role", () => {
    expect(botVoice({ name: "Mochi", title: "Friend", description: "Someone to chat with." })).toBe("personal");
    expect(botVoice({ name: "Patch", title: "Code reviewer", soul: "Be funny and roast my PRs." })).toBe("personal");
    expect(botVoice({ name: "Mochi", title: "Friend", soul: "No jokes, keep it short." })).toBe("work");
  });

  it("leaves a bot whose setup says nothing about its role open", () => {
    expect(botVoice({ name: "Kiran" })).toBe("open");
    expect(botVoice({ name: "Atlas", title: "Personal assistant" })).toBe("open");
    expect(botVoice({ name: "dusk bot" })).toBe("open");
  });

  it("gives a work bot the output-first colleague, and every other bot the funny friend", () => {
    expect(characterPrompt("work", "")).toBe(WORK_DEFAULT_SOUL_PROMPT + WORK_CHARACTER_PROMPT);
    expect(characterPrompt("work", "my soul")).toBe(WORK_CHARACTER_PROMPT);
    expect(characterPrompt("open", "")).toBe(DEFAULT_SOUL_PROMPT + CHARACTER_PROMPT);
    expect(characterPrompt("personal", "x")).toBe(CHARACTER_PROMPT);
    expect(WORK_CHARACTER_PROMPT).toContain("your first words are the answer, the result, the number or the fix; never a greeting");
    expect(WORK_CHARACTER_PROMPT).toContain("the talking style's playful parts are off for this bot");
    expect(WORK_CHARACTER_PROMPT).not.toMatch(/funny|comeback built/);
    expect(CHARACTER_PROMPT).toContain("the first is the result or a reaction, never a plan;");
  });

  it("puts the bot's voice into its system prompt", () => {
    const work = buildSystemPrompt("You are Forge.", "", [], undefined, { voice: "work" }).text;
    expect(work).toContain(WORK_CHARACTER_PROMPT);
    expect(work).not.toContain(CHARACTER_PROMPT);
    expect(buildSystemPrompt("You are Pip.", "", []).text).toContain(DEFAULT_SOUL_PROMPT + CHARACTER_PROMPT);
  });

  it("has the app's short lines for a work bot written as a colleague, not a funny friend", () => {
    const input = { name: "Forge", title: "Ops", ask: "what's failing on #214", steps: [], said: [] };
    expect(beatPrompt("ack", input)).toContain("Forge is a work bot and texts like a sharp colleague");
    expect(beatPrompt("ack", { ...input, title: undefined, name: "Pip" })).toContain("Pip texts like a smart, funny friend");
  });
});

describe("skill authoring", () => {
  it("builds skills on known good practice and still reports the change in a line", () => {
    expect(AUTHORING_STANDARDS).toContain("Build on known good practice");
    const learn = buildLearnPrompt("how we cut a release");
    expect(learn).toContain("look up one or two well-regarded sources for this kind of work first");
    expect(learn).toContain("tell the user the skill name and a one-line summary");
  });
});
