import { describe, expect, it } from "vitest";
import { builtInVoiceKnows, callLanguage } from "./language";

describe("callLanguage", () => {
  it("takes the bot's own language first, then Settings > Voice, then the app's, then the computer's", () => {
    expect(callLanguage({ bot: "ru", voiceInput: "de-DE", app: "fr", device: "en-US" })).toBe("ru");
    expect(callLanguage({ voiceInput: "de-DE", app: "fr", device: "en-US" })).toBe("de-DE");
    expect(callLanguage({ voiceInput: "", app: "ru", device: "en-US" })).toBe("ru");
    expect(callLanguage({ app: null, device: "ru-RU" })).toBe("ru-RU");
    expect(callLanguage({})).toBe("en");
  });

  it("skips a value that is not a language tag", () => {
    expect(callLanguage({ bot: "auto", app: "", device: "ru-RU" })).toBe("ru-RU");
  });
});

describe("builtInVoiceKnows", () => {
  it("knows English only", () => {
    expect(builtInVoiceKnows("en")).toBe(true);
    expect(builtInVoiceKnows("en-GB")).toBe(true);
    expect(builtInVoiceKnows("ru")).toBe(false);
    expect(builtInVoiceKnows("pt-BR")).toBe(false);
  });
});
