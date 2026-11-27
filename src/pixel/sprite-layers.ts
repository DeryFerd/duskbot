import { BODY, EYE, defOf, stillFrame } from "./core";

export type EyeKind = "open" | "wide" | "big" | "happy" | "sad" | "closed" | "x";
/** One eye: its shape, how far the top lid is down (0 open, 1 shut) and the bottom lid up. */
export type Eye = { k: EyeKind; lid: number; lidB: number };

type Box = { x: number; y: number; w: number; h: number };
type Pt = [number, number];

/** A part that turns on its own (an ear, antenna, leaf, tuft): which side it sits on and its path at an angle. */
export type SpriteLayer = { side: -1 | 0 | 1; at: (degrees: number) => string };

/** A body's still sprite split into the parts that move apart: the body, each turning part drawn again on the same
 * pixel grid at its angle, and the eyes drawn fresh from the boxes the engine places them in. Paths are in the G by G
 * body box's own units. */
export type SpriteLayers = {
  G: number;
  base: string;
  layers: SpriteLayer[];
  /** both eyes' paths for a face looking `gx`, `gy` whole pixels away, each falling back to a simpler shape where it
   * would not sit inside the body */
  eyes: (left: Eye, right: Eye, gx: number, gy: number) => [string, string];
  /** the nearest look the eyes of `k` fit at */
  clamp: (k: EyeKind, gx: number, gy: number) => [number, number];
};

const known = new Map<string, SpriteLayers>();

function runs(cells: Iterable<number>, W: number, ox: number, oy: number): string {
  const sorted = [...cells].sort((a, b) => a - b);
  let d = "";
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!, x = c % W, y = (c / W) | 0;
    let e = x;
    while (i + 1 < sorted.length && sorted[i + 1] === y * W + e + 1) { e++; i++; }
    d += `M${x - ox} ${y - oy}h${e - x + 1}v1h${-(e - x + 1)}z`;
  }
  return d;
}

/** The left eye's pixels for `e` in the shapes the engine draws (core.ts drawEyes), with lids. */
function shape(b: Box, e: Eye): Pt[] {
  const p: Pt[] = [];
  const box = (bx: number, by: number, bw: number, bh: number) => { for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) p.push([bx + i, by + j]); };
  const { x, w } = b;
  let k = e.k;
  if (k === "open" || k === "wide" || k === "big") {
    const grow = k === "open" ? 0 : 1;
    const y = b.y - grow, h = b.h + grow;
    const bx = k === "big" && w >= 2 ? x - 1 : x, bw = k === "big" && w >= 2 ? w + 1 : w;
    const top = Math.round(Math.min(1, Math.max(0, e.lid)) * h), bottom = Math.round(Math.min(1, Math.max(0, e.lidB)) * h * 0.5);
    if (h - top - bottom > 0) { box(bx, y + top, bw, h - top - bottom); return p; }
    k = "closed";
  }
  switch (k) {
    case "closed": box(w === 1 ? x - 1 : x, b.y + b.h - 1 - (b.h >= 4 ? 1 : 0), Math.max(w, 2), 1); break;
    case "happy": { const r = b.y + Math.floor(b.h / 2) - 1; box(x, r, w, 1); p.push([x - 1, r + 1], [x + w, r + 1]); if (b.h >= 5) p.push([x - 1, r + 2], [x + w, r + 2]); break; }
    case "sad":
      for (let j = 0; j < b.h - 1; j++) for (let i = 0; i < w; i++) {
        if ((j === 0 && (i === w - 1 || (w >= 3 && i === w - 2))) || (b.h >= 4 && j === 1 && i === w - 1 && w >= 2)) continue;
        p.push([x + i, b.y + 1 + j]);
      }
      break;
    case "x": { const n = b.h >= 5 ? 5 : 3, a = Math.floor(x + (w - n) / 2), c = Math.floor(b.y + (b.h - n) / 2); for (let i = 0; i < n; i++) p.push([a + i, c + i], [a + n - 1 - i, c + i]); break; }
  }
  return p;
}

const SIMPLER: Record<EyeKind, Eye | null> = {
  big: { k: "wide", lid: 0, lidB: 0 }, wide: { k: "open", lid: 0, lidB: 0 }, happy: { k: "closed", lid: 0, lidB: 0 },
  sad: { k: "open", lid: 0.5, lidB: 0 }, x: { k: "closed", lid: 0, lidB: 0 }, open: null, closed: null,
};

export function spriteLayers(body: string): SpriteLayers {
  const hit = known.get(body);
  if (hit) return hit;
  const def = defOf(body);
  const f = stillFrame(body, { scale: 1 });
  const { W, H, px, pt, G } = f;
  const base = new Set<number>(), groups = new Map<number, Set<number>>(), eyeCells: number[] = [];
  for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) {
    const i = gy * W + gx, v = f.paint[i];
    if (!v) continue;
    if (v === EYE) eyeCells.push(i);
    const x = gx - px + 0.5, y = gy - pt + 0.5;
    let inBase = 0, group = -1;
    for (const part of def.parts) {
      if (!part.test(x, y, 1)) continue;
      if (part.g < 0) inBase = part.cut ? 0 : 1;
      else if (!part.cut) group = part.g;
    }
    if (inBase || group < 0) base.add(i);
    else { if (!groups.has(group)) groups.set(group, new Set()); groups.get(group)!.add(i); }
  }
  const layers: SpriteLayer[] = [];
  for (const [g, cells] of groups) {
    const parts = def.parts.filter((part) => part.g === g);
    const pivot = parts.find((part) => part.piv)?.piv ?? [G / 2, G / 2];
    const mirrored = parts.some((part) => part.m === -1);
    const side: -1 | 0 | 1 = mirrored ? 1 : pivot[0] < G / 2 - 0.5 ? -1 : pivot[0] > G / 2 + 0.5 ? 1 : 0;
    const rest = runs(cells, W, px, pt);
    const turned = new Map<number, string>([[0, rest]]);
    // turned about its pivot and drawn again on the body's own pixel grid, in the engine's 3 degree steps
    const at = (degrees: number) => {
      const q = Math.round(degrees / 3) * 3;
      const seen = turned.get(q);
      if (seen !== undefined) return seen;
      const a = (-q * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
      const set: number[] = [];
      for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) {
        const x = gx - px + 0.5 - pivot[0], y = gy - pt + 0.5 - pivot[1];
        const sx = pivot[0] + x * cs - y * sn, sy = pivot[1] + x * sn + y * cs;
        if (parts.some((part) => !part.cut && part.test(sx, sy, 1))) set.push(gy * W + gx);
      }
      const d = runs(set, W, px, pt);
      turned.set(q, d);
      return d;
    };
    layers.push({ side, at });
  }
  const mid = eyeCells.length ? (Math.min(...eyeCells.map((i) => i % W)) + Math.max(...eyeCells.map((i) => i % W))) / 2 : W / 2;
  const boxOf = (cells: number[]): Box => {
    if (!cells.length) return { x: G / 2 - 1, y: G / 2, w: 1, h: 1 };
    const xs = cells.map((i) => (i % W) - px), ys = cells.map((i) => ((i / W) | 0) - pt);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 };
  };
  const left = boxOf(eyeCells.filter((i) => i % W < mid)), right = boxOf(eyeCells.filter((i) => i % W > mid));
  const sum = left.x + right.x + right.w - 1;
  const solid = (x: number, y: number) => {
    const gx = x + px, gy = y + pt;
    if (gx < 0 || gy < 0 || gx >= W || gy >= H) return false;
    const v = f.paint[gy * W + gx];
    return (v === BODY || v === EYE) && base.has(gy * W + gx);
  };
  const inner = (x: number, y: number) => { for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (!solid(x + i, y + j)) return false; return true; };
  const pair = (l: Eye, r: Eye): [Pt[], Pt[]] => [shape(left, l), shape(left, r).map(([x, y]): Pt => [sum - x, y])];
  const fits = (pts: Pt[], gx: number, gy: number) => pts.every(([x, y]) => inner(x + gx, y + gy));
  const rows = new Map<EyeKind, Map<number, [number, number]>>();
  const rowsOf = (k: EyeKind) => {
    const seen = rows.get(k);
    if (seen) return seen;
    const both = pair({ k, lid: 0, lidB: 0 }, { k, lid: 0, lidB: 0 }).flat();
    const out = new Map<number, [number, number]>();
    for (let dy = -2; dy <= 2; dy++) {
      if (!fits(both, 0, dy)) continue;
      let x0 = 0, x1 = 0;
      while (x0 > -2 && fits(both, x0 - 1, dy)) x0--;
      while (x1 < 2 && fits(both, x1 + 1, dy)) x1++;
      out.set(dy, [x0, x1]);
    }
    if (!out.size) out.set(0, [0, 0]);
    rows.set(k, out);
    return out;
  };
  const clamp = (k: EyeKind, gx: number, gy: number): [number, number] => {
    const r = rowsOf(k), ys = [...r.keys()].sort((a, b) => Math.abs(a - gy) - Math.abs(b - gy));
    const y = ys[0]!, [x0, x1] = r.get(y)!;
    return [Math.max(x0, Math.min(x1, gx)), y];
  };
  const fitted = (e: Eye, side: 0 | 1, gx: number, gy: number): Eye => {
    let eye = e;
    for (let n = 0; n < 3; n++) {
      const pts = pair(eye, eye)[side];
      const next = SIMPLER[eye.k];
      if (fits(pts, gx, gy) || !next) return eye;
      eye = next;
    }
    return eye;
  };
  const cell = ([x, y]: Pt) => `M${x} ${y}h1v1h-1z`;
  const layered: SpriteLayers = {
    G, base: runs(base, W, px, pt), layers, clamp,
    eyes(l, r, gx, gy) {
      const [L] = pair(fitted(l, 0, gx, gy), r), [, R] = pair(l, fitted(r, 1, gx, gy));
      return [L.map(cell).join(""), R.map(cell).join("")];
    },
  };
  known.set(body, layered);
  return layered;
}
