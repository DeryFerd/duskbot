import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { PDF_TEXT_LIMITS, type PdfTextReply } from "./pdf-text-contract.ts";

export class PdfTextError extends Error {}
const ERRORS = {
  corrupt: "That PDF could not be read. Try a valid, unlocked copy or page images.",
  password: "The PDF is password protected. Save an unlocked copy first.",
  empty: "The PDF has no readable text. Pass page images for a scanned document.",
  large: "The PDF has too much text for one extraction. Split it into smaller PDFs.",
  pages: "The PDF has more than 500 pages. Split it into smaller PDFs.",
} as const;
let active = 0;

export async function pdfText(bytes: Buffer, signal?: AbortSignal): Promise<string> {
  if (bytes.length > PDF_TEXT_LIMITS.fileBytes) throw new PdfTextError("The PDF is over 25 MB. Split it into smaller PDFs.");
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new PdfTextError(ERRORS.corrupt);
  if (signal?.aborted) throw new PdfTextError("PDF extraction was cancelled.");
  if (active >= 2) throw new PdfTextError("PDF extraction is busy. Try again shortly.");
  active++;
  let worker: Worker | undefined;
  try {
    const data = Uint8Array.from(bytes);
    const source = new URL("./pdf-text.worker.ts", import.meta.url);
    worker = new Worker(existsSync(source) ? source : new URL("./pdf-text.worker.js", import.meta.url), {
      workerData: data, transferList: [data.buffer], execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true, stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const parser = worker;
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, text?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancelled);
        if (error) reject(error); else resolve(text!);
      };
      const cancelled = () => finish(new PdfTextError("PDF extraction was cancelled."));
      const tooLong = () => finish(new PdfTextError("Reading the PDF took too long. Split it into smaller PDFs."));
      // starting the worker (loading pdf.js) has its own, longer cap: on a busy machine it alone can take seconds
      let timer = setTimeout(tooLong, PDF_TEXT_LIMITS.startMs);
      signal?.addEventListener("abort", cancelled, { once: true });
      parser.on("message", (reply: PdfTextReply) => {
        if ("ready" in reply) {
          clearTimeout(timer);
          timer = setTimeout(tooLong, PDF_TEXT_LIMITS.timeoutMs);
        } else if ("error" in reply) finish(new PdfTextError(ERRORS[reply.error]));
        else if (Buffer.byteLength(reply.text) > PDF_TEXT_LIMITS.textBytes) finish(new PdfTextError(ERRORS.large));
        else finish(undefined, reply.text);
      });
      parser.once("error", () => finish(new PdfTextError("Reading the PDF exceeded its memory limit or could not finish. Split it into smaller PDFs.")));
      parser.once("exit", () => finish(new PdfTextError(ERRORS.corrupt)));
      if (signal?.aborted) cancelled();
    });
  } finally {
    if (worker) await worker.terminate();
    active--;
  }
}
