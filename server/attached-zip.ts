// A .zip the person attached is unpacked once beside the uploads, and the bot gets the folder and its file list.
// Security invariants: nothing lands outside the folder (no absolute, `..`, drive or device paths, no links), nothing is
// written past the size its directory declares, and the declared sizes and entry count are capped before a byte is
// written, so a zip bomb or a zip-slip archive is refused or skipped rather than unpacked.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

import { extractZipMember, readZipDirectory, safeArchivePath, type ZipMember } from "./zip-archive.ts";

export const ZIP_LIMITS = {
  entries: 2_000,
  unpackedBytes: 200 * 1024 * 1024,
  /** Files named in the turn; the rest are counted and stay in the folder. */
  listed: 200,
} as const;

const MANIFEST = ".dusk-unpacked.json";
const UNIX_TYPE_MASK = 0o170000;
const UNIX_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const JUNK = /(?:^|\/)(?:__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

export interface UnpackedZip {
  folder: string;
  files: Array<{ path: string; bytes: number }>;
  /** Entries left out: links, unsafe paths or duplicate names. */
  skipped: number;
}

export class ZipUnpackError extends Error {}

function kindOf(entry: ZipMember): "file" | "directory" | "other" {
  const type = (entry.externalAttributes >>> 16) & UNIX_TYPE_MASK;
  if (entry.name.endsWith("/")) return type === 0 || type === UNIX_DIRECTORY ? "directory" : "other";
  return type === 0 || type === UNIX_FILE ? "file" : "other";
}

/** The members to unpack, every one a plain file at a safe relative path; throws when the archive is too big. */
export function plannedMembers(entries: readonly ZipMember[]): { members: ZipMember[]; skipped: number } {
  const members: ZipMember[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let bytes = 0;
  for (const entry of entries) {
    const kind = kindOf(entry);
    if (kind === "directory" || JUNK.test(entry.name)) continue;
    const key = entry.name.normalize("NFC").toLowerCase();
    if (kind !== "file" || !safeArchivePath(entry.name) || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    bytes += entry.uncompressedBytes;
    if (bytes > ZIP_LIMITS.unpackedBytes) {
      throw new ZipUnpackError(`it unpacks to more than ${ZIP_LIMITS.unpackedBytes / 1024 / 1024} MB`);
    }
    members.push(entry);
  }
  return { members, skipped };
}

async function readManifest(folder: string): Promise<UnpackedZip | null> {
  try {
    const kept = JSON.parse(await readFile(join(folder, MANIFEST), "utf8")) as Omit<UnpackedZip, "folder">;
    return Array.isArray(kept.files) && typeof kept.skipped === "number" ? { folder, files: kept.files, skipped: kept.skipped } : null;
  } catch {
    return null;
  }
}

/** Unpacks an uploaded zip into `<cacheDir>/<upload name>-files` once; later turns read the kept list. */
export async function unpackAttachedZip(zipPath: string, cacheDir: string): Promise<UnpackedZip> {
  const folder = join(cacheDir, `${basename(zipPath)}-files`);
  const kept = await readManifest(folder);
  if (kept) return kept;
  let entries: ZipMember[];
  try {
    entries = await readZipDirectory(zipPath, ZIP_LIMITS.entries);
  } catch {
    throw new ZipUnpackError(`it is not a zip this can open (more than ${ZIP_LIMITS.entries.toLocaleString("en-US")} files, encrypted, split or damaged)`);
  }
  const { members, skipped } = plannedMembers(entries);
  const partial = `${folder}.${process.pid}-${randomUUID()}.partial`;
  await mkdir(partial, { recursive: true, mode: 0o700 });
  try {
    for (const member of members) {
      const parts = member.name.split("/");
      if (parts.length > 1) await mkdir(join(partial, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
      await extractZipMember(zipPath, member, join(partial, ...parts), 0o600);
    }
    const files = members.map((member) => ({ path: member.name, bytes: member.uncompressedBytes }));
    await writeFile(join(partial, MANIFEST), JSON.stringify({ files, skipped }), { mode: 0o600 });
    await rm(folder, { recursive: true, force: true });
    await rename(partial, folder);
    return { folder, files, skipped };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    if (error instanceof ZipUnpackError) throw error;
    throw new ZipUnpackError("a file inside it is damaged or larger than it says");
  }
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const attribute = (value: string) => value.replace(/[&"<>\r\n]/g, (c) => `&#${c.charCodeAt(0)};`);

/** What the turn carries for an unpacked zip: the folder, then one line per file. */
export function zipBlock(name: string, unpacked: UnpackedZip): string {
  const shown = unpacked.files.slice(0, ZIP_LIMITS.listed);
  const lines = shown.map((file) => `${file.path.replace(/[\r\n<>]/g, "_")} (${size(file.bytes)})`);
  const more = unpacked.files.length - shown.length;
  const notes = [
    `${unpacked.files.length === 1 ? "1 file" : `${unpacked.files.length} files`}`,
    more > 0 ? `${more} more not listed` : "",
    unpacked.skipped ? `${unpacked.skipped} left out (links, unsafe paths or repeated names)` : "",
  ].filter(Boolean).join("; ");
  return `<attached-zip-files path="${attribute(unpacked.folder)}" name="${attribute(name)}">\n${lines.join("\n")}\n</attached-zip-files>\n`
    + `[${name} is unpacked in that folder (${notes}). Read or copy its files from there; it has already been unzipped.]`;
}
