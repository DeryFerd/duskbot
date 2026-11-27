// Text whose digits roll when it changes: each digit is a drum (0 to 9 in a column) that springs to its value, keyed
// from the right, so "$15" -> "$49" or "2 of 4" -> "3 of 4" turns only the digits that differ. The text stays one plain
// text node (what sizes it and what a screen reader hears); the drawn copy over it is aria-hidden and has no text of its
// own. No hooks: the cloud sheet's tests render it as a plain function.
import { motion } from "motion/react";
import { cn } from "@/lib/cn";

const STRIP = "0\n1\n2\n3\n4\n5\n6\n7\n8\n9";
const DRAWN = "leading-[1.25em] before:whitespace-pre before:content-[attr(data-text)]";

function Drum({ digit, index, still }: { digit: number; index: number; still: boolean }) {
  return <span className="h-[1.25em] overflow-clip [mask-image:linear-gradient(transparent,#000_14%,#000_86%,transparent)]">
    <motion.span data-text={STRIP} className={cn("block text-center", DRAWN)}
      initial={false} animate={{ y: `${-digit * 1.25}em` }}
      transition={still ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 22 + 2 * index }} />
  </span>;
}

/** runs of text and single digits, keyed by their distance from the end */
function pieces(text: string): { key: string; digit?: number; text?: string }[] {
  const chars = [...text];
  const out: { key: string; digit?: number; text?: string }[] = [];
  chars.forEach((char, i) => {
    const key = String(chars.length - i);
    if (/\d/.test(char)) out.push({ key: `d${key}`, digit: Number(char) });
    else if (out.length && out[out.length - 1]!.text !== undefined) out[out.length - 1]!.text += char;
    else out.push({ key: `t${key}`, text: char });
  });
  return out;
}

export function RollingText({ text, className }: { text: string; className?: string }) {
  const still = globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  let drums = 0;
  return <span className={cn("relative inline-block whitespace-nowrap tabular-nums", className)}>
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
      {pieces(text).map((piece) => piece.digit === undefined
        ? <span key={piece.key} data-text={piece.text} className={DRAWN} />
        : <Drum key={piece.key} digit={piece.digit} index={drums++} still={still} />)}
    </span>
    <span className="opacity-0">{text}</span>
  </span>;
}
