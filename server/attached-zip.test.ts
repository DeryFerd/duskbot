import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import { withAttachedDocuments } from "./attached-documents.ts";
import { plannedMembers, unpackAttachedZip, ZIP_LIMITS, ZipUnpackError } from "./attached-zip.ts";
import { attachmentsForBox } from "./box-attachments.ts";
import { boxUploadsDir } from "./bot-box/plan.ts";
import { buildZip } from "./testing/zip-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "dusk-attached-zip-"));
const attachmentsDir = join(home, "attachments");
const cacheDir = join(home, "attachment-text");
mkdirSync(attachmentsDir);
let n = 0;
function upload(bytes: Buffer): string {
  const path = join(attachmentsDir, `5b1e0c3a-7d2f-4c1a-8b3e-${String(++n).padStart(12, "0")}.zip`);
  writeFileSync(path, bytes);
  return path;
}
const tag = (path: string, name: string) => `<attached-file path="${path}" name="${name}" />`;

describe("an attached zip", () => {
  it("is unpacked once and the turn lists its files under the folder, so the bot can use them without unzipping", async () => {
    const zip = upload(buildZip([
      { name: "ramxcodes-voice/", data: "" },
      { name: "ramxcodes-voice/intro.wav", data: Buffer.alloc(2048, 1) },
      { name: "ramxcodes-voice/notes.md", data: "# takes\n" },
      { name: "__MACOSX/ramxcodes-voice/._intro.wav", data: "junk" },
      { name: "ramxcodes-voice/.DS_Store", data: "junk" },
    ]));
    const result = await withAttachedDocuments(`unzip ramxcodes-voice.zip and attach the intro\n\n${tag(zip, "ramxcodes-voice.zip")}`, { vision: false, imageRoom: 10, attachmentsDir, cacheDir });
    const folder = join(cacheDir, `${basename(zip)}-files`);
    expect(result.text).toContain(`${tag(zip, "ramxcodes-voice.zip")}\n<attached-zip-files path="${folder}" name="ramxcodes-voice.zip">\nramxcodes-voice/intro.wav (2.0 KB)\nramxcodes-voice/notes.md (8 B)\n</attached-zip-files>\n[ramxcodes-voice.zip is unpacked in that folder (2 files).`);
    expect(readFileSync(join(folder, "ramxcodes-voice", "notes.md"), "utf8")).toBe("# takes\n");
    expect(existsSync(join(folder, "__MACOSX"))).toBe(false);
    writeFileSync(join(folder, "ramxcodes-voice", "notes.md"), "changed by the bot");
    expect((await unpackAttachedZip(zip, cacheDir)).files).toHaveLength(2);
    expect(readFileSync(join(folder, "ramxcodes-voice", "notes.md"), "utf8")).toBe("changed by the bot");
  });

  it("never writes outside its folder: parent paths, absolute paths and links are left out and counted", async () => {
    const zip = upload(buildZip([
      { name: "../escaped.txt", data: "slip" },
      { name: "/etc/escaped.txt", data: "slip" },
      { name: "C:\\escaped.txt", data: "slip" },
      { name: "link", data: "/etc/passwd", mode: 0o120777 },
      { name: "Readme.txt", data: "one" },
      { name: "README.TXT", data: "two" },
      { name: "kept.txt", data: "ok" },
    ]));
    const unpacked = await unpackAttachedZip(zip, cacheDir);
    expect(unpacked.files.map((file) => file.path)).toEqual(["Readme.txt", "kept.txt"]);
    expect(unpacked.skipped).toBe(5);
    expect(existsSync(join(cacheDir, "escaped.txt"))).toBe(false);
    expect(existsSync(join(home, "escaped.txt"))).toBe(false);
    expect(readdirSync(unpacked.folder).sort()).toEqual([".dusk-unpacked.json", "Readme.txt", "kept.txt"]);
    const result = await withAttachedDocuments(tag(zip, "odd.zip"), { vision: false, imageRoom: 10, attachmentsDir, cacheDir });
    expect(result.text).toContain("5 left out (links, unsafe paths or repeated names)");
  });

  it("refuses a zip bomb before writing a byte, and a member bigger than it declares", async () => {
    const huge = { name: "", compression: 8 as const, compressedBytes: 10, uncompressedBytes: ZIP_LIMITS.unpackedBytes / 2 + 1, localHeaderOffset: 0, externalAttributes: 0 };
    expect(() => plannedMembers([{ ...huge, name: "a.bin" }, { ...huge, name: "b.bin" }])).toThrow(ZipUnpackError);
    const lying = upload(buildZip([{ name: "small.txt", data: "a".repeat(100_000), declaredBytes: 10 }]));
    await expect(unpackAttachedZip(lying, cacheDir)).rejects.toThrow(ZipUnpackError);
    expect(readdirSync(cacheDir).filter((name) => name.startsWith(basename(lying)))).toEqual([]);
    const notZip = upload(Buffer.from("PK\x03\x04 this is not really a zip"));
    const result = await withAttachedDocuments(tag(notZip, "broken.zip"), { vision: false, imageRoom: 10, attachmentsDir, cacheDir });
    expect(result.text).toContain("[broken.zip could not be unpacked: it is not a zip this can open");
  });

  it("is shown to a boxed bot through the conversation's uploads folder", async () => {
    const dataDir = join(home, "box-data");
    const uploads = join(dataDir, "attachments");
    const cwd = join(dataDir, "task-workspaces", "bot", "thread");
    mkdirSync(uploads, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const zip = join(uploads, "5b1e0c3a-7d2f-4c1a-8b3e-999999999999.zip");
    writeFileSync(zip, buildZip([{ name: "voice/take.txt", data: "take one" }]));
    const text = await withAttachedDocuments(tag(zip, "voice.zip"), { vision: false, imageRoom: 10, attachmentsDir: uploads, cacheDir: join(dataDir, "attachment-text") });
    const shown = boxUploadsDir(dataDir, "bot", "thread");
    const boxed = attachmentsForBox(text.text, cwd, true, dataDir, uploads);
    expect(boxed).toContain(`<attached-zip-files path="${join(shown, "5b1e0c3a-7d2f-4c1a-8b3e-999999999999.zip-files")}" name="voice.zip">`);
    expect(readFileSync(join(shown, "5b1e0c3a-7d2f-4c1a-8b3e-999999999999.zip-files", "voice", "take.txt"), "utf8")).toBe("take one");
  });
});
