import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(join(here, "..", "styles.css"), "utf8");
const chat = readFileSync(join(here, "chat.css"), "utf8");

describe("on a touch screen", () => {
  it("every small chat and composer control takes a 44px press around it without changing its look", () => {
    const rule = /@media \(hover: none\), \(pointer: coarse\) \{\s*:is\(([^)]*(?:\([^)]*\))?[^)]*)\)::after \{([^}]*)\}/.exec(styles);
    expect(rule).not.toBeNull();
    for (const control of ["[data-composer-actions] button", "button[data-composer-plus]", "[data-composer-attachment] button", "[data-code-plate] button", "[data-table-card] button"]) {
      expect(rule![1]).toContain(control);
    }
    expect(rule![2]).toMatch(/width: max\(100%, 44px\);\s*height: max\(100%, 44px\);/);
    expect(styles).toMatch(/@layer base \{\s*@media \(hover: none\), \(pointer: coarse\) \{\s*:is\([^{]*\) \{\s*position: relative;/);
  });

  it("the timestamp waiting past a row's edge is clipped by the row, so the chat never scrolls sideways", () => {
    expect(chat).toMatch(/\[data-message-row\]:has\(> \.chat-row-ts\) \{\s*overflow-x: clip;\s*\}/);
  });
});
