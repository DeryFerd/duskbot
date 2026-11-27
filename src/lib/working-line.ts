import type { PixelState } from "@/pixel/engine";
import type { WorkingMood } from "./working-mood";
import { pacedMs } from "./motion-speed";

/** How the chat's working line moves. "shipped" keeps TurnPresence's own entry, the opacity pulse and WorkingMascot's
 * MASCOT_MOTION; the others draw the mascot with WorkingLineMascot and style the line by `data-working-line`. */
export const WORKING_LINE_PICKS = ["restore", "drift", "ponder", "rock", "ellipsis"] as const;
export type WorkingLineVariant = (typeof WORKING_LINE_PICKS)[number];
/** "glance" draws the mascot with GlanceMascot: its face does the acting, moved by CSS and timers, not a frame loop. */
export type WorkingLinePick = "shipped" | WorkingLineVariant | "glance";

export const WORKING_LINE: WorkingLinePick = "glance";

/** How a version's line comes and goes, and what carries its thinking besides the mascot. */
export type LineSpec = {
  /** the line leaving once the reply takes its place, in ms */
  exitMs: number;
  /** three dots rising over the mascot's head while it thinks */
  thoughtDots: boolean;
  /** an ellipsis after the words that fills in dot by dot */
  ellipsis: boolean;
};

const SHIPPED_EXIT_MS = pacedMs(140);

export const LINE_SPECS: Record<WorkingLinePick, LineSpec> = {
  shipped: { exitMs: SHIPPED_EXIT_MS, thoughtDots: false, ellipsis: false },
  restore: { exitMs: pacedMs(200), thoughtDots: false, ellipsis: false },
  drift: { exitMs: pacedMs(240), thoughtDots: false, ellipsis: false },
  ponder: { exitMs: pacedMs(200), thoughtDots: true, ellipsis: false },
  rock: { exitMs: pacedMs(200), thoughtDots: false, ellipsis: false },
  glance: { exitMs: pacedMs(200), thoughtDots: false, ellipsis: false },
  ellipsis: { exitMs: pacedMs(240), thoughtDots: false, ellipsis: true },
};

/** One look of the mascot: the sprite's face, its sideways look (-1, 0 or 1) and how long it holds, in ms. */
type Look = { face: PixelState; look?: number; ms: number };

/** Where the mascot is at one moment. It never travels: y lifts it (box sizes, negative is up), sx and sy squash it
 * about its feet, rot tilts it about its feet in degrees. `from` and `to` are the faces it crossfades between at `mix`;
 * eyeX and eyeY shift the eyes alone (sprite pixels); blink is how shut they are (0 to 1); dots are the thought dots'
 * progress (0 to 1 each, negative when hidden). */
export type LinePose = {
  y: number; sx: number; sy: number; rot: number;
  from: Look; to: Look; mix: number;
  eyeX: number; eyeY: number; blink: number;
  dots: number;
};

const TAU = Math.PI * 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (k: number) => { const v = clamp01(k); return v * v * (3 - 2 * v); };
const easeInOut = (k: number) => { const v = clamp01(k); return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2; };
const wave = (t: number, period: number, phase = 0) => Math.sin(TAU * (t / period + phase));
/** -1..1 that rests at each side and glides between them, one cycle per `period` s */
const sway = (t: number, period: number, phase = 0) => Math.max(-1, Math.min(1, wave(t, period, phase) * 1.5));

/** The faces each version runs a mood through, on a loop. */
const RESTORE_FACES: Record<WorkingMood, readonly Look[]> = {
  thinking: [{ face: "thinking", ms: 2800 }, { face: "thinking", look: 1, ms: 2400 }, { face: "confused", ms: 2000 }],
  reading: [{ face: "working", ms: 3000 }],
  writing: [{ face: "working", ms: 3000 }],
  replying: [{ face: "happy", ms: 2000 }, { face: "working", ms: 60_000 }],
  running: [{ face: "working", ms: 3200 }, { face: "listening", ms: 2000 }],
  searching: [{ face: "searching", ms: 2400 }, { face: "listening", ms: 2000 }, { face: "searching", look: 1, ms: 2400 }, { face: "listening", ms: 2000 }],
  browsing: [{ face: "listening", ms: 2800 }, { face: "searching", ms: 2000 }, { face: "listening", ms: 2400 }, { face: "searching", look: 1, ms: 2000 }],
  waiting: [{ face: "idle", ms: 3000 }, { face: "confused", ms: 2000 }],
  error: [{ face: "sad", ms: 4000 }],
  done: [{ face: "happy", ms: 4000 }],
};

/** Calmer faces: fewer changes, each held longer. */
const CALM_FACES: Record<WorkingMood, readonly Look[]> = {
  ...RESTORE_FACES,
  thinking: [{ face: "thinking", ms: 3600 }, { face: "thinking", look: 1, ms: 3600 }],
  searching: [{ face: "searching", ms: 3200 }, { face: "searching", look: 1, ms: 3200 }],
  browsing: [{ face: "listening", ms: 3200 }, { face: "searching", ms: 3200 }],
  replying: [{ face: "happy", ms: 2400 }, { face: "working", ms: 60_000 }],
};

type Variant = {
  faces: Record<WorkingMood, readonly Look[]>;
  /** how long a face crossfades into the next, in ms */
  faceFadeMs: number;
  /** how long a change of mood glides, in ms */
  blendMs: number;
  blinkEvery: number;
  blinkMs: number;
  body: (mood: WorkingMood, t: number, pose: LinePose, seedPhase: number) => void;
};

function breathe(p: LinePose, t: number, period: number, amount: number, phase: number): void {
  const b = (1 - Math.cos(TAU * (t / period + phase))) / 2;
  p.sy += amount * b;
  p.sx -= amount * 0.55 * b;
}

/** one soft hop every `period` s: a lift on a sine arc, a squash as it lands that springs back */
function hop(p: LinePose, t: number, period: number, height: number, phase: number): void {
  const u = ((t / period + phase) % 1 + 1) % 1;
  if (u < 0.5) {
    const a = u / 0.5;
    p.y -= height * Math.sin(Math.PI * a);
    p.sy += height * 0.5 * Math.sin(Math.PI * a);
    p.sx -= height * 0.3 * Math.sin(Math.PI * a);
  } else {
    const s = Math.sin(Math.PI * ((u - 0.5) / 0.5)) * Math.exp(-2.2 * ((u - 0.5) / 0.5));
    p.sy -= height * 0.9 * s;
    p.sx += height * 0.6 * s;
  }
}

/** a single hop played once over `ms`, `k` from 0 to 1 */
function hopOnce(p: LinePose, k: number, height: number): void {
  if (k <= 0 || k >= 1) return;
  if (k < 0.6) { const a = k / 0.6; p.y -= height * Math.sin(Math.PI * a); p.sy += height * 0.4 * Math.sin(Math.PI * a); }
  else { const a = (k - 0.6) / 0.4; const s = Math.sin(Math.PI * a) * (1 - a); p.sy -= height * 0.8 * s; p.sx += height * 0.5 * s; }
}

const VARIANTS: Record<WorkingLineVariant, Variant> = {
  /** faces looking up one way then the other, a pixel of bob, a slow blink, every step a glide */
  restore: {
    faces: RESTORE_FACES, faceFadeMs: 360, blendMs: 900, blinkEvery: 3800, blinkMs: 240,
    body(mood, t, p, ph) {
      const bob = (1 - Math.cos(TAU * (t / 2.2 + ph))) / 2;
      switch (mood) {
        case "thinking": p.y -= 0.035 * bob; p.rot += 5 * sway(t, 6.4, ph); break;
        case "searching": case "browsing": p.y -= 0.035 * bob; p.rot += 4 * sway(t, 4.4, ph); break;
        case "reading": p.rot += 2.5 * wave(t, 3.6, ph); break;
        case "writing": case "running": p.y -= 0.05 * ((1 - Math.cos(TAU * (t / 1.1 + ph))) / 2); break;
        case "replying": hopOnce(p, t / 0.9, 0.12); if (t > 0.9) p.y -= 0.05 * ((1 - Math.cos(TAU * ((t - 0.9) / 1.1))) / 2); break;
        case "waiting": p.y -= 0.03 * bob; p.rot += 3 * sway(t, 5, ph); break;
        case "error": p.sy -= 0.06; p.sx += 0.03; p.rot -= 5; break;
        case "done": hopOnce(p, t / 0.8, 0.1); break;
      }
    },
  },
  /** the calmest: breathing, the eyes gliding about and up while it thinks, slow blinks */
  drift: {
    faces: CALM_FACES, faceFadeMs: 600, blendMs: 1200, blinkEvery: 4600, blinkMs: 300,
    body(mood, t, p, ph) {
      breathe(p, t, 3.6, 0.05, ph);
      const gaze = sway(t, mood === "thinking" ? 7.2 : 5.6, ph);
      switch (mood) {
        case "thinking": p.eyeX += 0.9 * gaze; p.eyeY -= 0.6 + 0.3 * wave(t, 3.6, ph); p.rot += 3 * gaze; break;
        case "searching": case "browsing": p.eyeX += 1 * gaze; p.rot += 2 * gaze; break;
        case "reading": p.eyeX += 0.7 * wave(t, 2.8, ph); p.eyeY += 0.4; break;
        case "writing": case "running": case "replying": p.eyeY += 0.4; p.rot += 1.5 * wave(t, 3.6, ph); break;
        case "waiting": p.eyeX += 0.6 * gaze; break;
        case "error": p.sy -= 0.05; p.rot -= 4; break;
        case "done": break;
      }
    },
  },
  /** thinking you can see: three dots rise over its head while it tilts and ponders */
  ponder: {
    faces: CALM_FACES, faceFadeMs: 420, blendMs: 1000, blinkEvery: 4200, blinkMs: 260,
    body(mood, t, p, ph) {
      breathe(p, t, 3.2, 0.04, ph);
      switch (mood) {
        case "thinking": p.rot += 7 * sway(t, 5.6, ph); p.eyeY -= 0.5; p.dots = (t / 2.1) % 1; break;
        case "searching": case "browsing": p.rot += 5 * sway(t, 4, ph); p.eyeX += 0.8 * sway(t, 4, ph); break;
        case "reading": p.rot += 3 * wave(t, 3.2, ph); p.eyeY += 0.4; break;
        case "writing": case "running": p.rot += 3 * wave(t, 1.6, ph); p.y -= 0.02 * ((1 - Math.cos(TAU * t / 1.6)) / 2); break;
        case "replying": hopOnce(p, t / 0.9, 0.1); p.rot += 3 * wave(t, 1.6, ph); break;
        case "waiting": p.rot += 4 * sway(t, 5, ph); break;
        case "error": p.sy -= 0.06; p.rot -= 6; break;
        case "done": hopOnce(p, t / 0.8, 0.1); break;
      }
    },
  },
  /** livelier but soft: it rocks heel to heel while it thinks and hops in place, squashing as it lands, while it works */
  rock: {
    faces: RESTORE_FACES, faceFadeMs: 300, blendMs: 800, blinkEvery: 3600, blinkMs: 220,
    body(mood, t, p, ph) {
      switch (mood) {
        case "thinking": {
          const s = sway(t, 3.2, ph);
          p.rot += 9 * s; p.y -= 0.03 * Math.abs(s); breathe(p, t, 3.2, 0.03, ph);
          break;
        }
        case "searching": case "browsing": p.rot += 6 * sway(t, 2.8, ph); p.eyeX += 0.8 * sway(t, 2.8, ph); break;
        case "reading": p.rot += 3 * wave(t, 2.4, ph); p.y -= 0.02 * ((1 - Math.cos(TAU * t / 2.4)) / 2); break;
        case "writing": case "running": hop(p, t, 1.2, 0.08, ph); break;
        case "replying": hopOnce(p, t / 0.9, 0.16); if (t > 0.9) hop(p, t - 0.9, 1.2, 0.07, 0); break;
        case "waiting": breathe(p, t, 3, 0.04, ph); p.rot += 4 * sway(t, 4.4, ph); break;
        case "error": p.sy -= 0.07; p.sx += 0.04; p.rot -= 6; break;
        case "done": hopOnce(p, t / 0.8, 0.12); break;
      }
    },
  },
  /** a quiet mascot that breathes and blinks; the words' own ellipsis carries the thinking */
  ellipsis: {
    faces: CALM_FACES, faceFadeMs: 520, blendMs: 1100, blinkEvery: 4200, blinkMs: 280,
    body(mood, t, p, ph) {
      breathe(p, t, 3.4, 0.045, ph);
      switch (mood) {
        case "thinking": p.rot += 4 * sway(t, 6.8, ph); p.eyeY -= 0.4; break;
        case "searching": case "browsing": p.rot += 3 * sway(t, 4.8, ph); p.eyeX += 0.7 * sway(t, 4.8, ph); break;
        case "writing": case "running": case "reading": p.rot += 2 * wave(t, 3.4, ph); p.eyeY += 0.3; break;
        case "replying": hopOnce(p, t / 1, 0.08); break;
        case "waiting": p.rot += 3 * sway(t, 5, ph); break;
        case "error": p.sy -= 0.05; p.rot -= 5; break;
        case "done": break;
      }
    },
  },
};

function lookAt(looks: readonly Look[], ms: number, fadeMs: number): { from: Look; to: Look; mix: number } {
  const cycle = looks.reduce((sum, look) => sum + look.ms, 0);
  let left = cycle > 0 ? ms % cycle : 0;
  for (let i = 0; i < looks.length; i++) {
    const look = looks[i]!;
    if (left < look.ms) {
      const next = looks[(i + 1) % looks.length]!;
      const fade = Math.min(fadeMs, look.ms / 2);
      return { from: look, to: next, mix: looks.length > 1 ? smooth((left - (look.ms - fade)) / fade) : 0 };
    }
    left -= look.ms;
  }
  const only = looks[0]!;
  return { from: only, to: only, mix: 0 };
}

/** A whole blink as a smooth close and open, every `every` ms on the mascot's own phase. */
function blinkAt(ms: number, every: number, length: number, offset: number): number {
  const u = (ms + offset) % every;
  return u < length ? Math.sin((Math.PI * u) / length) : 0;
}

export function seedPhase(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** The pose of `variant` in `mood`, `ms` after the mood began. Reduced motion holds the mood's first face, still. */
export function poseIn(variant: WorkingLineVariant, mood: WorkingMood, ms: number, phase: number, reduced = false): LinePose {
  const spec = VARIANTS[variant];
  const looks = spec.faces[mood];
  const pose: LinePose = { y: 0, sx: 1, sy: 1, rot: 0, from: looks[0]!, to: looks[0]!, mix: 0, eyeX: 0, eyeY: 0, blink: 0, dots: -1 };
  if (reduced) return pose;
  Object.assign(pose, lookAt(looks, ms, spec.faceFadeMs));
  spec.body(mood, ms / 1000, pose, phase);
  const shut = pose.from.face === "happy" || pose.from.face === "sad" ? 0 : blinkAt(ms, spec.blinkEvery, spec.blinkMs, phase * spec.blinkEvery);
  pose.blink = shut;
  return pose;
}

/** A change of mood glides: the old pose eases into the new over the version's blend, its face crossfading as it goes. */
export function blendPoses(was: LinePose, now: LinePose, k: number): LinePose {
  if (k >= 1) return now;
  const e = easeInOut(k), mixOf = (a: number, b: number) => a + (b - a) * e;
  const wasFace = was.mix < 0.5 ? was.from : was.to;
  const nowFace = now.mix < 0.5 ? now.from : now.to;
  return {
    y: mixOf(was.y, now.y), sx: mixOf(was.sx, now.sx), sy: mixOf(was.sy, now.sy), rot: mixOf(was.rot, now.rot),
    from: wasFace, to: nowFace, mix: e,
    eyeX: mixOf(was.eyeX, now.eyeX), eyeY: mixOf(was.eyeY, now.eyeY), blink: Math.max(was.blink, now.blink) * (1 - Math.sin(Math.PI * e)),
    dots: now.dots >= 0 ? now.dots : was.dots >= 0 && e < 1 ? was.dots : -1,
  };
}

export function blendMs(variant: WorkingLineVariant): number {
  return VARIANTS[variant].blendMs;
}

/** How visible the thought dots are as thinking comes and goes: they fade with the mood's blend. */
export function dotsShown(was: WorkingMood | null, now: WorkingMood, k: number): number {
  const on = (mood: WorkingMood | null) => (mood === "thinking" ? 1 : 0);
  if (!was || k >= 1) return on(now);
  return on(was) + (on(now) - on(was)) * easeInOut(k);
}
