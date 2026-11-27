export const PDF_TEXT_LIMITS = { fileBytes: 25 * 1024 * 1024, textBytes: 256 * 1024, pages: 500, timeoutMs: 10_000, startMs: 60_000 } as const;
/** `ready`: the worker has loaded its parser; the read limit counts from here, so a slow worker start is not the PDF's fault. */
export type PdfTextReply = { ready: true } | { text: string } | { error: "corrupt" | "password" | "empty" | "large" | "pages" };
