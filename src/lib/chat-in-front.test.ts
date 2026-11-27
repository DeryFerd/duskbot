import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { chatInFront, setAppAway, setChatCovered } from "./chat-in-front";

afterEach(() => { setChatCovered(false); setAppAway(false); });
const focused = { hasFocus: () => true }, away = { hasFocus: () => false };

describe("chat in front", () => {
  it("is the focused page's selected chat, as on the desktop", () => {
    expect(chatInFront(focused)).toBe(true);
    expect(chatInFront(away)).toBe(false);
  });

  it("a chat the backgrounded phone app still shows is not being read, though its page keeps focus", () => {
    setAppAway(true);
    expect(chatInFront(focused)).toBe(false);
    setAppAway(false);
    expect(chatInFront(focused)).toBe(true);
  });

  it("a chat under the phone's list is not being read, however focused the app is", () => {
    setChatCovered(true);
    expect(chatInFront(focused)).toBe(false);
    setChatCovered(false);
    expect(chatInFront(focused)).toBe(true);
  });

  it("every place that reads a reply for the person asks this, never the page's focus alone", () => {
    for (const file of ["../state/store.tsx", "./notify.ts"]) {
      const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(text, file).toContain("chatInFront()");
      expect(text, file).not.toContain("document.hasFocus()");
    }
    const shell = readFileSync(fileURLToPath(new URL("../mobile/MobileApp.tsx", import.meta.url)), "utf8");
    expect(shell).toContain("setChatCovered(chatId === null)");
  });
});
