import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRACTIONAL_SIZE = /text-\[\d+\.\d+px\]|font-size:\s*\d+\.\d+px|fontSize:\s*\d+\.\d+(?![\d.])/g;
// the working line sits alone under the reply, so it has no neighbouring step to blur into
const CHOSEN_HALF_STEPS = new Set([`components/TurnPresence.tsx: text-[${13.5}px]`]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

describe("type scale", () => {
  it("sizes text in whole pixels, so neighbouring steps stay distinct", () => {
    const offenders = sourceFiles(srcRoot).flatMap((file) =>
      (readFileSync(file, "utf8").match(FRACTIONAL_SIZE) ?? []).map((size) => `${relative(srcRoot, file).replaceAll("\\", "/")}: ${size}`),
    ).filter((offender) => !CHOSEN_HALF_STEPS.has(offender));
    expect(offenders).toEqual([]);
  });
});
