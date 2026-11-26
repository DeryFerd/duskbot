import { existsSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { PDF_TEXT_LIMITS, type PdfTextReply } from "./pdf-text-contract.ts";

const parser = await import("pdfjs-dist/legacy/build/pdf.mjs");
Object.assign(globalThis, { pdfjsWorker: await import("pdfjs-dist/legacy/build/pdf.worker.mjs") });
parentPort!.postMessage({ ready: true } satisfies PdfTextReply);
const bundledAssets = new URL("./pdf-assets/", import.meta.url);
const assets = existsSync(bundledAssets) ? bundledAssets : new URL("../node_modules/pdfjs-dist/", import.meta.url);
// pdf.js wants these folders to end in "/", and a Windows path ends in a backslash (fs reads either separator)
const folder = (name: string) => fileURLToPath(new URL(name, assets)).replaceAll("\\", "/");
const task = parser.getDocument({
  data: workerData, useSystemFonts: true, disableFontFace: true,
  isOffscreenCanvasSupported: false, isImageDecoderSupported: false, useWasm: false, verbosity: 0,
  cMapUrl: folder("cmaps/"), cMapPacked: true, standardFontDataUrl: folder("standard_fonts/"),
});
let reply: PdfTextReply;
try {
  const document = await task.promise;
  if (document.numPages > PDF_TEXT_LIMITS.pages) reply = { error: "pages" };
  else {
    const parts: string[] = [];
    let bytes = 0;
    let large = false;
    for (let i = 1; i <= document.numPages && !large; i++) {
      const page = await document.getPage(i);
      const reader = page.streamTextContent().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (!("str" in item)) continue;
            const text = item.str + (item.hasEOL ? "\n" : " ");
            bytes += Buffer.byteLength(text);
            if (bytes > PDF_TEXT_LIMITS.textBytes) { large = true; break; }
            parts.push(text);
          }
          if (large) { await reader.cancel(new Error("PDF text limit")); break; }
        }
      } finally {
        reader.releaseLock();
        page.cleanup();
      }
      parts.push("\n\f\n");
      bytes += 3;
      if (bytes > PDF_TEXT_LIMITS.textBytes) large = true;
    }
    const text = parts.join("").trim();
    reply = large ? { error: "large" } : text ? { text } : { error: "empty" };
  }
} catch (error) {
  reply = { error: error instanceof Error && error.name === "PasswordException" ? "password" : "corrupt" };
} finally {
  await task.destroy();
}
parentPort!.postMessage(reply);
