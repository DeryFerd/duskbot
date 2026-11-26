import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { CompactionNote } from "./CompactionNote";

const compacted = (by: "person" | "harness", awayHours?: number): Message => ({
  id: "c", role: "bot", kind: "compaction", at: 1,
  compaction: { by, summary: "", firstKeptId: "", foldedThroughId: "", tokensBefore: 0, ...(awayHours === undefined ? {} : { awayHours }) },
});

describe("compaction note", () => {
  it("is the chat's centered event line, in its own words", () => {
    const markup = renderToStaticMarkup(createElement(CompactionNote, { message: compacted("person") }));
    expect(markup).toMatch(/^<div role="status" data-transcript-note="" data-compaction-note="person" data-event-line="" class="[^"]*justify-center/);
    expect(markup).toContain("Compacted this chat. The whole chat stays here");
  });

  it("shows nothing for an automatic summary: the size threshold, hours away", () => {
    expect(renderToStaticMarkup(createElement(CompactionNote, { message: compacted("harness") }))).toBe("");
    expect(renderToStaticMarkup(createElement(CompactionNote, { message: compacted("harness", 7) }))).toBe("");
  });
});
