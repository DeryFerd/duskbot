import { feature } from "./product-analytics";
import {
  discardUnsentUpload,
  fileAttachmentFromFile,
  handoffAttachmentImagePreview,
  imageAttachmentFromFile,
  releaseAttachmentImagePreview,
  uploadTurnedAway,
  type Attachment,
  type FileAttachment,
  type ImageAttachment,
} from "./composer-attachments";
import { replaceDraftAttachment } from "./drafts";
import { dropUploadSource, endUpload, keepUploadSource, reportUpload, startUpload, uploadSource } from "./upload-progress";

type Placed = ImageAttachment | FileAttachment;

/**
 * Sends the bytes behind a tile already in the draft and swaps in the saved attachment. A failure that a retry could fix
 * keeps the tile, marked failed, so it can be retried or removed; bytes the server turned away for good take the tile
 * off. Either way the error is rethrown for the notice.
 */
export async function sendPlacedUpload(draftId: string, placed: Placed, file: File): Promise<void> {
  const { id } = placed;
  const signal = startUpload(id, file.size);
  keepUploadSource(id, file);
  const transfer = { signal, onProgress: (loaded: number, total: number) => reportUpload(id, loaded, total) };
  let completed: Attachment | null;
  try {
    completed = placed.kind === "image"
      ? await imageAttachmentFromFile(file, placed, transfer)
      : await fileAttachmentFromFile(file, { ...transfer, id });
  } catch (error) {
    endUpload(id);
    // removed while it uploaded
    if (signal.aborted) return;
    const gone = uploadTurnedAway(error);
    const shown = replaceDraftAttachment(draftId, id, gone ? null : { ...placed, uploading: false, failed: true });
    if (shown && !gone) throw error;
    dropUploadSource(id);
    if (placed.kind === "image") releaseAttachmentImagePreview(placed);
    if (shown) throw error;
    return;
  }
  endUpload(id);
  dropUploadSource(id);
  if (!completed) {
    replaceDraftAttachment(draftId, id, null);
    if (placed.kind === "image") releaseAttachmentImagePreview(placed);
    return;
  }
  if (completed.kind === "image") handoffAttachmentImagePreview(completed.path, completed.previewUrl);
  if (!replaceDraftAttachment(draftId, id, completed)) {
    if (completed.kind === "image") releaseAttachmentImagePreview(completed);
    discardUnsentUpload(completed);
  } else feature("file_uploaded");
}

/** Sends a failed tile's file again; a tile with no file left to send is taken off instead. */
export async function retryPlacedUpload(draftId: string, attachment: Attachment): Promise<void> {
  if (attachment.kind === "paste" || !attachment.failed) return;
  const file = uploadSource(attachment.id);
  if (!file) {
    replaceDraftAttachment(draftId, attachment.id, null);
    return;
  }
  const placed: Placed = { ...attachment, uploading: true, failed: false };
  if (!replaceDraftAttachment(draftId, attachment.id, placed)) return;
  await sendPlacedUpload(draftId, placed, file);
}
