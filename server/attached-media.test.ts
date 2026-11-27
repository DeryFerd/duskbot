import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withAttachedDocuments } from "./attached-documents.ts";
import { heifAsJpeg } from "./attached-media.ts";
import { pdfFixture } from "./testing/pdf-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "dusk-attached-media-"));
const attachmentsDir = join(home, "attachments");
const cacheDir = join(home, "attachment-text");
mkdirSync(attachmentsDir);
mkdirSync(cacheDir);
let n = 0;
function upload(extension: string, bytes: Buffer): string {
  const path = join(attachmentsDir, `7c2d1e0f-3a4b-4c5d-8e6f-${String(++n).padStart(12, "0")}${extension}`);
  writeFileSync(path, bytes);
  return path;
}
const tag = (path: string, name: string) => `<attached-file path="${path}" name="${name}" />`;
const read = (text: string, vision = true) => withAttachedDocuments(text, { vision, imageRoom: 10, attachmentsDir, cacheDir });
const sips = process.platform === "darwin" && existsSync("/usr/bin/sips");

describe("an attached video", () => {
  it("rides as its file, and the bot is told it is a video it can't watch here", async () => {
    const clip = upload(".mov", Buffer.alloc(3 * 1024 * 1024));
    const result = await read(`what happens at the end?\n\n${tag(clip, "demo.mov")}`);
    expect(result.text).toBe(`what happens at the end?\n\n${tag(clip, "demo.mov")}\n[demo.mov is a video (3.0 MB). It can't be watched here; its file is at the path above.]`);
    expect(result.images).toEqual([]);
  });
});

describe("an attached iPhone photo", () => {
  it.skipIf(!sips)("becomes a JPEG the AI sees as a picture, made once", async () => {
    const png = join(home, "red.png");
    writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
    const heic = upload(".heic", Buffer.alloc(0));
    execFileSync("/usr/bin/sips", ["-s", "format", "heic", png, "--out", heic], { stdio: "ignore" });
    const result = await read(tag(heic, "IMG_0042.HEIC"));
    expect(result.text).toContain("[IMG_0042.HEIC is an iPhone photo, attached as a picture.]");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.mime).toBe("image/jpeg");
    expect(readFileSync(result.images[0]!.path).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect((await read(tag(heic, "IMG_0042.HEIC"))).images[0]!.path).toBe(result.images[0]!.path);
  });

  it("says so plainly when nothing here can convert it, or the AI sees no pictures", async () => {
    const heic = upload(".heic", Buffer.from("not really a photo"));
    expect(await heifAsJpeg(heic, cacheDir, [() => null, (input, output) => ["/bin/sh", ["-c", "exit 1", input, output]]])).toBeNull();
    const blind = await read(tag(heic, "IMG_1.HEIC"), false);
    expect(blind.images).toEqual([]);
    expect(blind.text).toContain("[IMG_1.HEIC is an iPhone (HEIC) photo that can't be shown as a picture here; its file is at the path above.]");
  });

  it("leaves other documents as they were", async () => {
    const pdf = upload(".pdf", pdfFixture(["Total due: 12"]));
    expect((await read(tag(pdf, "bill.pdf"))).text).toContain("Total due: 12");
  });
});
