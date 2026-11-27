import { describe, expect, it } from "vitest";
import { RELEASE_ICONS } from "../../../shared/release-notes";
import { CHANGE_GLYPHS } from "./ChangeIcon";

describe("change icons", () => {
  it("draws every icon a changelog may name on a full 12 by 12 grid of known inks", () => {
    for (const icon of RELEASE_ICONS) {
      const rows = CHANGE_GLYPHS[icon];
      expect(rows, icon).toHaveLength(12);
      for (const row of rows) expect(row, icon).toMatch(/^[.vlypbwgoc]{12}$/);
    }
  });
});
