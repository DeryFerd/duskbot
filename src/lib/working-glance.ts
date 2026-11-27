import type { EyeKind } from "@/pixel/sprite-layers";
import type { WorkingMood } from "./working-mood";

/** What the glance mascot shows at one moment. Its face does the acting: where the eyes look (whole sprite pixels),
 * their shape and lids, how far each ear turns out (degrees; negative perks it in), a small lift and a sink. Lids from
 * different sources (a blink, a narrowing, a slow blink) are kept apart and the most shut one wins. */
export type GlanceState = {
  gx: number; gy: number;
  holdX: number | null; holdY: number | null;
  kind: EyeKind;
  lid: number; lidOver: number | null;
  blinkA: number; blinkB: number; slow: number; wake: number;
  bias: number; sideL: number; sideR: number; flickL: number; flickR: number;
  /** lift in sprite pixels and how long the move to it takes */
  rise: number; riseMs: number;
  /** 0 upright, 1 sunk a little lower and wider */
  sink: number;
};

export type GlanceEvent = { at: number; set: Partial<GlanceState> };

export const GLANCE_REST: GlanceState = {
  gx: 0, gy: 0, holdX: null, holdY: null, kind: "open", lid: 0, lidOver: null,
  blinkA: 0, blinkB: 0, slow: 0, wake: 0, bias: 0, sideL: 0, sideR: 0, flickL: 0, flickR: 0, rise: 0, riseMs: 200, sink: 0,
};

/** how long a change of step takes, and when in it the face changes */
export const GLANCE_BLEND_MS = 380;
export const GLANCE_SWAP_S = 0.19;

export const glanceLid = (s: GlanceState) => Math.max(s.lidOver ?? s.lid, s.blinkA, s.blinkB, s.slow, s.wake);
export const glanceGaze = (s: GlanceState): [number, number] => [s.holdX ?? s.gx, s.holdY ?? s.gy];
export const glanceEars = (s: GlanceState): [number, number] => [s.bias + s.sideL + s.flickL, s.bias + s.sideR + s.flickR];

/** The one face a step holds under reduced motion, and where a step's face starts. */
export const GLANCE_STILL: Record<WorkingMood, Partial<GlanceState>> = {
  thinking: { kind: "open", gx: 1, gy: -1, bias: 3 },
  searching: { kind: "wide", bias: -4 },
  browsing: { kind: "open", gy: 1 },
  reading: { kind: "open", lid: 0.34, gy: 1 },
  writing: { kind: "open", lid: 0.34, gy: 1 },
  running: { kind: "open", lid: 0.34, gx: 1, gy: 1, bias: -2 },
  replying: { kind: "open", gy: 1, bias: -2 },
  waiting: { kind: "open", gx: 1, gy: -1, bias: 4 },
  error: { kind: "sad", gx: -1, gy: 1, bias: 16 },
  done: { kind: "happy", bias: -7 },
};

function rngOf(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type Channel = Generator<GlanceEvent, void, undefined>;
const between = (r: () => number, min: number, max: number) => min + (max - min) * r();
const soon = (r: () => number, first: number) => first * (0.6 + 0.4 * r());

/** a lid closing fast, held, opening a touch slower */
function* blinkFrames(at: number, key: "blinkA" | "blinkB" | "slow", dur = 0.17): Channel {
  yield { at, set: { [key]: 0.5 } };
  yield { at: at + dur * 0.24, set: { [key]: 1 } };
  yield { at: at + dur * 0.65, set: { [key]: 0.5 } };
  yield { at: at + dur, set: { [key]: 0 } };
}

function* blinks(r: () => number, key: "blinkA" | "slow", first: number, min: number, max: number, dur = 0.17): Channel {
  for (let at = soon(r, first); ; at += between(r, min, max)) yield* blinkFrames(at, key, dur);
}

/** an ear flicking out and settling back now and then */
function* flicks(r: () => number): Channel {
  for (let at = soon(r, 3); ; at += between(r, 4.5, 9)) {
    const key = r() < 0.5 ? "flickL" : "flickR";
    for (const [dt, deg] of [[0, 6], [0.03, 12], [0.1, 9], [0.16, 6], [0.22, 3], [0.3, 0]] as const) yield { at: at + dt, set: { [key]: deg } };
  }
}

/** spots picked one at a time at irregular gaps, never the same twice running */
function* looks(r: () => number, spots: ReadonlyArray<readonly [number, number]>, first: number, min: number, max: number, also?: (at: number, spot: readonly [number, number]) => Iterable<GlanceEvent>): Channel {
  let last = -1;
  for (let at = soon(r, first); ; at += between(r, min, max)) {
    let pick = Math.floor(r() * spots.length);
    if (pick === last) pick = (pick + 1) % spots.length;
    last = pick;
    const spot = spots[pick]!;
    yield { at, set: { gx: spot[0], gy: spot[1] } };
    if (also) yield* also(at, spot);
  }
}

/** a held look away (or a narrowing) every so often */
function* holds(r: () => number, first: number, min: number, max: number, on: Partial<GlanceState>, length: number, off: Partial<GlanceState>, extra?: (at: number) => Iterable<GlanceEvent>): Channel {
  for (let at = soon(r, first); ; at += between(r, min, max)) {
    yield { at, set: on };
    if (extra) yield* extra(at);
    yield { at: at + length, set: off };
  }
}

function* cycle(step: number, start: number, each: (n: number) => Partial<GlanceState>): Channel {
  for (let n = 0; ; n++) yield { at: start + n * step, set: each(n) };
}

function* once(events: GlanceEvent[]): Channel { yield* events; }

function channels(mood: WorkingMood, seed: string): Channel[] {
  const r = (name: string) => rngOf(`${seed}|${mood}|${name}`);
  const start = once([{ at: 0, set: { ...GLANCE_STILL[mood], gx: GLANCE_STILL[mood].gx ?? 0, gy: GLANCE_STILL[mood].gy ?? 0 } }]);
  const common = [start, flicks(r("flick"))];
  const normal = blinks(r("blink"), "blinkA", 1.6, 3.2, 6);
  switch (mood) {
    case "thinking": {
      const rb = r("saccade");
      // looks up one way, then the other; blinks as the eyes move more often than not; now and then narrows to think hard
      return [...common, normal,
        looks(r("look"), [[-1, -1], [1, -1], [0, -1], [1, -1], [-1, -1]], 0.25, 1.6, 3, (at) => (rb() < 0.55 ? blinkFrames(at + 0.02, "blinkB") : [])),
        holds(r("hard"), 5.5, 7, 10, { lidOver: 0.34 }, 1.3, { lidOver: null })];
    }
    case "searching":
      return [...common, normal,
        looks(r("look"), [[-1, 0], [1, 0], [-1, -1], [1, -1], [0, -1], [1, 1], [-1, 1]], 0.12, 0.5, 0.85, (at, [x]) => [{ at, set: { sideL: x < 0 ? -5 : 0, sideR: x > 0 ? -5 : 0 } }])];
    case "browsing":
      return [...common, normal,
        looks(r("look"), [[-1, 0], [1, 1], [0, 1], [1, 0], [-1, 1], [0, 0]], 0.2, 1, 1.6, (at) => [{ at: at + 0.46, set: { lidOver: 0.34 } }, { at: at + 0.62, set: { lidOver: null } }])];
    case "reading":
      // three stops along a line, a quick sweep back and down; at the end of a paragraph it looks up and blinks
      return [...common, normal, (function* (): Channel {
        for (let n = 0; ; n++) {
          const at = n * 1.15;
          if (n % 4 === 3) { yield { at, set: { gx: 0, gy: 0 } }; yield* blinkFrames(at + 0.2, "blinkB"); continue; }
          yield { at, set: { gx: -1, gy: n % 2 } };
          yield { at: at + 0.36, set: { gx: 0 } };
          yield { at: at + 0.72, set: { gx: 1 } };
        }
      })()];
    case "writing":
      // eyes on the words, stepping along with them; every few seconds a look up at you
      // the look up starts and ends on a word's beat, so the eyes never make two moves in a row
      return [...common, normal, cycle(0.42, 0, (n) => ({ gx: [-1, 0, 1, 1][n % 4]! })), (function* (): Channel {
        const ru = r("up");
        for (let at = soon(ru, 4); ; at += between(ru, 5, 7.5)) {
          const on = Math.ceil(at / 0.42) * 0.42;
          yield { at: on, set: { holdX: 1, holdY: -1, lidOver: 0 } };
          yield* blinkFrames(on, "blinkB");
          yield { at: on + 0.84, set: { holdX: null, holdY: null, lidOver: null } };
        }
      })()];
    case "running":
      // watches the command: one spot, slow patient blinks, now and then a look up to check
      return [...common, blinks(r("slow"), "slow", 2, 3.4, 5, 0.36), holds(r("peek"), 4.5, 6, 9, { holdX: 0, holdY: 0 }, 1, { holdX: null, holdY: null })];
    case "replying":
      // a pleased beat with a small lift, then the eyes follow the words out
      return [...common, normal,
        once([{ at: 0, set: { kind: "happy", bias: -6, rise: 0.8, riseMs: 120 } }, { at: 0.24, set: { rise: 0, riseMs: 400 } }, { at: 0.9, set: { kind: "open", bias: -2 } }]),
        cycle(0.38, 0.9, (n) => ({ gx: [-1, 0, 1, 1, 0][n % 5]!, gy: 1 }))];
    case "waiting": {
      // looks up at you: slow blinks, the lids sinking a little between them; now and then a look away
      const rs = r("slow");
      return [...common, (function* (): Channel {
        let rest = 0;
        for (let at = soon(rs, 2.4); ; at += between(rs, 3.6, 5.2)) {
          if (rest + 2.1 < at) yield { at: rest + 2.1, set: { lid: 0.34 } };
          yield { at, set: { lid: 0 } };
          yield* blinkFrames(at, "slow", 0.42);
          rest = at + 0.42;
        }
      })(), holds(r("away"), 6, 7, 10, { holdX: -1, holdY: 0 }, 1.6, { holdX: null, holdY: null })];
    }
    case "error":
      // a flinch, then sad eyes, ears down and a little lower
      return [...common, once([{ at: 0, set: { kind: "closed", sink: 1 } }, { at: 0.16, set: { kind: "sad" } }])];
    case "done":
      return [...common, once([{ at: 0, set: { rise: 1, riseMs: 140 } }, { at: 0.24, set: { rise: 0, riseMs: 350 } }])];
  }
}

/** Every change in a step, in time order (seconds since the step began), from all its channels at once. */
export function* glanceEvents(mood: WorkingMood, seed: string): Generator<GlanceEvent, void, undefined> {
  const live = channels(mood, seed).map((c) => ({ c, next: c.next() }));
  for (;;) {
    let first: (typeof live)[number] | null = null;
    for (const l of live) if (!l.next.done && (!first || l.next.value.at < (first.next as IteratorYieldResult<GlanceEvent>).value.at)) first = l;
    if (!first) return;
    yield (first.next as IteratorYieldResult<GlanceEvent>).value;
    first.next = first.c.next();
  }
}
