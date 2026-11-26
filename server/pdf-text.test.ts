import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { pdfText } from "./pdf-text.ts";
import { PDF_TEXT_LIMITS } from "./pdf-text-contract.ts";
import { pdfFixture } from "./testing/pdf-fixture.ts";

describe("built-in PDF text extraction", () => {
  it("reads every page and preserves Unicode", async () => {
    const text = await pdfText(pdfFixture(["Page one: café München €1080", "Page two: paid invoice INV-2291"]));
    expect(text).toContain("café München €1080");
    expect(text).toContain("Page two: paid invoice INV-2291");
    expect(text.indexOf("Page one")).toBeLessThan(text.indexOf("Page two"));
  });
  it("reads Unicode fonts that need bundled character maps", async () => {
    const text = await pdfText(readFileSync(new URL("./testing/fixtures/unicode-cmap.pdf", import.meta.url)));
    expect(text).toContain("你好 世界");
  });
  it("rejects corrupt, locked and image-only documents plainly", async () => {
    await expect(pdfText(Buffer.from("%PDF-1.7\nbroken"))).rejects.toThrow("could not be read");
    await expect(pdfText(readFileSync(new URL("./testing/fixtures/password-protected.pdf", import.meta.url)))).rejects.toThrow("password protected");
    await expect(pdfText(pdfFixture([""]))).rejects.toThrow("no readable text");
  });
  it("rejects excessive decoded output instead of returning a partial document", async () => {
    const page = Array.from({ length: 60 }, () => "x".repeat(70)).join("\n");
    await expect(pdfText(pdfFixture(Array.from({ length: 100 }, () => page)))).rejects.toThrow("too much text");
  });
  it("rejects excessive page count before reading page contents", async () => {
    await expect(pdfText(pdfFixture(Array.from({ length: 501 }, () => "small")))).rejects.toThrow("more than 500 pages");
  });
  it("bounds input before starting a worker", async () => {
    await expect(pdfText(Buffer.alloc(25 * 1024 * 1024 + 1))).rejects.toThrow("over 25 MB");
  });
  it("cancels parsing and releases its worker slot", async () => {
    const abort = new AbortController();
    const result = pdfText(pdfFixture(["Cancelled"]), abort.signal);
    abort.abort();
    await expect(result).rejects.toThrow("cancelled");
    expect(await pdfText(pdfFixture(["Next PDF"]))).toContain("Next PDF");
  });
  // a worker that never gets its parser loaded hits the start cap; the read limit counts only once it is ready
  it("terminates the worker at its deadline and releases the slot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = pdfText(pdfFixture(["Timed out"]));
      const rejected = expect(result).rejects.toThrow("took too long");
      await vi.advanceTimersByTimeAsync(PDF_TEXT_LIMITS.startMs);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
    expect(await pdfText(pdfFixture(["After deadline"]))).toContain("After deadline");
  });
});
