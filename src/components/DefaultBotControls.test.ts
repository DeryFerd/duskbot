import { describe, expect, it } from "vitest";

import en from "../locales/en.json";
import { SETTINGS_PANES } from "@/lib/open-settings";

// the note after hiding dusk bot names where its switch is (Models, under New bots); a pane with no rail row cannot be
// found from Settings, so the note must never send the person there
describe("hiding dusk bot from the sidebar", () => {
  for (const key of ["defaultBot.hidden", "defaultBot.hideHint"] as const) {
    it(`${key} names a pane Settings lists`, () => {
      const named = /settings → ([^.]+)\./.exec(en[key])?.[1];
      const pane = SETTINGS_PANES.find((entry) => (en as Record<string, string>)[entry.labelKey]?.toLowerCase() === named?.toLowerCase());
      expect(pane?.id).toBe("models");
      expect(pane?.rail).not.toBe(false);
    });
  }
});
