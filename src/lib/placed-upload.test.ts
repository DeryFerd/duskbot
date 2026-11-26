import { afterEach, describe, expect, it, vi } from "vitest";
import { pendingFileAttachment, type FileAttachment } from "./composer-attachments";
import { appendDraftAttachments, getDraftAttachments, setDraftAttachments } from "./drafts";
import { retryPlacedUpload, sendPlacedUpload } from "./placed-upload";
import { cancelUpload, uploadSource, uploadState } from "./upload-progress";
import { setUploadRoute, type UploadInit, type UploadProgress } from "./upload-request";

type Pending = { url: string; init: UploadInit; onProgress: UploadProgress; resolve: (response: Response) => void; reject: (error: unknown) => void };

function routeUploads() {
  const pending: Pending[] = [];
  const stop = setUploadRoute((url, init, onProgress) => new Promise<Response>((resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    pending.push({ url, init, onProgress, resolve, reject });
  }));
  return { pending, stop };
}

const draft = (id: string) => getDraftAttachments(undefined, id);
let stop = () => {};
afterEach(() => stop());

function placeFile(draftId: string, name = "report.pdf", size = 9 * 1024 * 1024) {
  const file = new File([new Uint8Array(size)], name, { type: "application/pdf" });
  const tile = pendingFileAttachment(file)!;
  setDraftAttachments(undefined, draftId, []);
  appendDraftAttachments(draftId, [tile]);
  return { file, tile };
}

const saved = (bytes: number) => new Response(JSON.stringify({ path: "/files/0f0e0d0c-0b0a-4908-8706-050403020100.pdf", name: "report.pdf", bytes }), { status: 201 });

describe("an upload placed in the draft", () => {
  it("reports its bytes to the tile and becomes the saved file under the same id", async () => {
    const routes = routeUploads();
    stop = routes.stop;
    const { file, tile } = placeFile("bot:a:t");
    expect(draft("bot:a:t")).toEqual([expect.objectContaining({ id: tile.id, uploading: true, path: "" })]);

    const sent = sendPlacedUpload("bot:a:t", tile, file);
    await Promise.resolve();
    const request = routes.pending[0]!;
    expect(request.url).toMatch(/^\/api\/files\?name=report\.pdf&uploadId=/);
    request.onProgress(0, file.size);
    request.onProgress(file.size * 0.77, file.size);
    expect(uploadState(tile.id)).toMatchObject({ size: file.size, loaded: file.size * 0.77, total: file.size });

    request.resolve(saved(file.size));
    await sent;
    const [done] = draft("bot:a:t") as FileAttachment[];
    expect(done).toMatchObject({ kind: "file", id: tile.id, name: "report.pdf", size: file.size });
    expect(done!.path).toMatch(/\.pdf$/);
    expect(done!.uploading).toBeUndefined();
    expect(uploadState(tile.id)).toBeUndefined();
    expect(uploadSource(tile.id)).toBeUndefined();
  });

  it("stays on the tile as failed, keeps its file, and uploads again on retry", async () => {
    const routes = routeUploads();
    stop = routes.stop;
    const { file, tile } = placeFile("bot:b:t", "notes.pdf", 1024);

    const sent = sendPlacedUpload("bot:b:t", tile, file);
    await Promise.resolve();
    routes.pending[0]!.reject(new TypeError("Failed to fetch"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // one automatic retry before the tile fails
    routes.pending[1]!.reject(new TypeError("Failed to fetch"));
    await expect(sent).rejects.toThrow("Failed to fetch");
    const [failed] = draft("bot:b:t");
    expect(failed).toMatchObject({ id: tile.id, failed: true, uploading: false });
    expect(uploadState(tile.id)).toBeUndefined();
    expect(uploadSource(tile.id)).toBe(file);

    const retried = retryPlacedUpload("bot:b:t", failed!);
    expect(draft("bot:b:t")[0]).toMatchObject({ id: tile.id, failed: false, uploading: true });
    await Promise.resolve();
    routes.pending[2]!.resolve(saved(1024));
    await retried;
    expect(draft("bot:b:t")[0]).toMatchObject({ kind: "file", id: tile.id, size: 1024 });
    expect((draft("bot:b:t")[0] as FileAttachment).failed).toBeUndefined();
  });

  it("takes its tile off when the server turns the bytes away for good, and names the file in the notice", async () => {
    const routes = routeUploads();
    stop = routes.stop;
    const { file, tile } = placeFile("bot:d:t", "scan.pdf", 64);
    const sent = sendPlacedUpload("bot:d:t", tile, file);
    await Promise.resolve();
    routes.pending[0]!.resolve(new Response(JSON.stringify({ error: "file bytes are not application/pdf" }), { status: 400 }));
    const error = await sent.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 400 });
    expect(routes.pending).toHaveLength(1);
    expect(draft("bot:d:t")).toEqual([]);
    expect(uploadSource(tile.id)).toBeUndefined();
    const { uploadFailure } = await import("./intake-files");
    expect(uploadFailure("scan.pdf", error)).toBe("scan.pdf wasn't attached: it's damaged, or it isn't the kind of file its name says.");
    expect(uploadFailure("notes.pdf", new TypeError("Failed to fetch"))).toBe("notes.pdf didn't upload. Check your connection, then retry it or remove it.");
  });

  it("turns away a picture no browser can draw before uploading it, however it came in, and takes its tile off", async () => {
    const routes = routeUploads();
    stop = routes.stop;
    const { optimisticImageAttachment } = await import("./composer-attachments");
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], "cut.png", { type: "image/png" });
    globalThis.URL.createObjectURL ??= () => "blob:x";
    const tile = optimisticImageAttachment(file)!;
    setDraftAttachments(undefined, "bot:e:t", []);
    appendDraftAttachments("bot:e:t", [tile]);
    const decode = vi.fn(async () => { throw new Error("InvalidStateError: The source image could not be decoded."); });
    vi.stubGlobal("createImageBitmap", decode);
    try {
      const error = await sendPlacedUpload("bot:e:t", tile, file).catch((caught: unknown) => caught);
      expect(decode).toHaveBeenCalledWith(file);
      expect(error).toMatchObject({ status: 400 });
      expect(routes.pending).toHaveLength(0);
      expect(draft("bot:e:t")).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("brings an iPhone photo back as a picture when the server turned it into a JPEG", async () => {
    const routes = routeUploads();
    stop = routes.stop;
    const file = new File([new Uint8Array(64)], "IMG_0042.HEIC", { type: "image/heic" });
    const tile = pendingFileAttachment(file)!;
    setDraftAttachments(undefined, "bot:f:t", []);
    appendDraftAttachments("bot:f:t", [tile]);
    const sent = sendPlacedUpload("bot:f:t", tile, file);
    await Promise.resolve();
    routes.pending[0]!.resolve(new Response(JSON.stringify({ path: "/a/0f0e0d0c-0b0a-4908-8706-050403020100.jpg", name: "IMG_0042.jpg", bytes: 900, mime: "image/jpeg" }), { status: 201 }));
    await sent;
    expect(draft("bot:f:t")).toEqual([expect.objectContaining({ kind: "image", id: tile.id, name: "IMG_0042.jpg", mime: "image/jpeg" })]);
  });

  it("stops quietly when its tile is removed mid-upload", async () => {
    const routes = routeUploads();
    stop = routes.stop;
    const { file, tile } = placeFile("bot:c:t");
    const sent = sendPlacedUpload("bot:c:t", tile, file);
    await Promise.resolve();
    setDraftAttachments(undefined, "bot:c:t", []);
    cancelUpload(tile.id);
    await expect(sent).resolves.toBeUndefined();
    expect(routes.pending).toHaveLength(1);
    expect(draft("bot:c:t")).toEqual([]);
  });
});
