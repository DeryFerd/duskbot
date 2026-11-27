// Videos and iPhone (HEIC/HEIF) photos the person attached. A video rides as a file the bot is told about; a HEIC photo
// becomes a JPEG once, through whichever converter the machine has, so an AI that sees pictures gets it as one.
import { execFile } from "node:child_process";
import { rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { whichOnPath } from "./bot-box/detect.ts";

const run = promisify(execFile);

export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([".mp4", ".mov"]);
export const HEIF_EXTENSIONS: ReadonlySet<string> = new Set([".heic", ".heif"]);

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function videoNote(name: string, bytes: number): string {
  return `[${name} is a video (${size(bytes)}). It can't be watched here; its file is at the path above.]`;
}

type Converter = (input: string, output: string) => [string, string[]] | null;

/** macOS ships sips; Linux has libheif's heif-convert or ImageMagick when installed. */
const CONVERTERS: Converter[] = [
  (input, output) => {
    const sips = process.platform === "darwin" ? whichOnPath("sips", { PATH: `${process.env.PATH ?? ""}:/usr/bin` }) : null;
    return sips ? [sips, ["-s", "format", "jpeg", input, "--out", output]] : null;
  },
  (input, output) => {
    const tool = whichOnPath("heif-convert");
    return tool ? [tool, ["-q", "85", input, output]] : null;
  },
  (input, output) => {
    const tool = whichOnPath("magick");
    return tool ? [tool, [input, output]] : null;
  },
];

/** The JPEG kept beside the uploads for a HEIC photo, made on first use; null when no converter can read it. */
export async function heifAsJpeg(path: string, cacheDir: string, converters: Converter[] = CONVERTERS): Promise<string | null> {
  const out = join(cacheDir, `${basename(path)}.jpg`);
  if ((await stat(out).catch(() => null))?.isFile()) return out;
  const partial = `${out}.${process.pid}.partial.jpg`;
  for (const converter of converters) {
    const command = converter(path, partial);
    if (!command) continue;
    try {
      await run(command[0], command[1], { timeout: 30_000 });
      if (!(await stat(partial).catch(() => null))?.size) continue;
      await rename(partial, out);
      return out;
    } catch {
      await rm(partial, { force: true });
    }
  }
  return null;
}
