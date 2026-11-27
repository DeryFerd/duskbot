import { useEffect, useLayoutEffect, useRef } from "react";
import { GLANCE_REST, GLANCE_STILL, GLANCE_SWAP_S, glanceEars, glanceEvents, glanceGaze, glanceLid, type GlanceEvent, type GlanceState } from "@/lib/working-glance";
import type { WorkingMood } from "@/lib/working-mood";
import { spriteLayers, type EyeKind } from "@/pixel/sprite-layers";

type Box = { width: number; height: number; left: number; top: number };

const useClientLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;
const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** an ear glides to a new resting angle in the engine's 3 degree steps, this far apart */
const EAR_STEP_MS = 35;

const stillOf = (mood: WorkingMood): GlanceState => ({ ...GLANCE_REST, ...GLANCE_STILL[mood] });
const gazeKind = (k: EyeKind): EyeKind => (k === "wide" || k === "big" || k === "happy" ? k : "open");

/** Plays one step's changes on timers: each change waits for its moment, so nothing runs between them. */
class Player {
  state: GlanceState;
  private events: Generator<GlanceEvent, void, undefined>;
  private pending: GlanceEvent | null = null;
  private began: number;
  constructor(mood: WorkingMood, seed: string, began: number) {
    this.events = glanceEvents(mood, seed);
    this.began = began;
    this.state = stillOf(mood);
    this.advance(began);
  }
  /** applies every change due by `at` (ms on the page clock) and says when the next one is due */
  advance(at: number): number {
    const t = (at - this.began) / 1000;
    for (;;) {
      const next = this.pending ?? this.events.next().value ?? null;
      if (!next) return Infinity;
      if (next.at > t) { this.pending = next; return this.began + next.at * 1000; }
      this.pending = null;
      Object.assign(this.state, next.set);
    }
  }
}

/** The chat's working mascot as picked ("glance"): its face does the acting. The body breathes on a CSS loop; the
 * eyes dart to each new look on a short CSS transition; lids, ears and the face change on timers at the moments a step
 * plans, so no script runs between changes. A new step glides the body and changes the face behind a blink. Reduced
 * motion holds the step's face still. */
export function GlanceMascot({ body, mood, seed, reduced, box, ink, eyeInk }: {
  body: string;
  mood: WorkingMood;
  seed: string;
  reduced: boolean;
  box: Box;
  ink: string;
  eyeInk: string;
}) {
  const sprite = spriteLayers(body);
  const unit = box.width / sprite.G;
  const sinkRef = useRef<HTMLSpanElement>(null);
  const riseRef = useRef<HTMLSpanElement>(null);
  const eyesRef = useRef<HTMLSpanElement>(null);
  const eyeL = useRef<SVGPathElement>(null);
  const eyeR = useRef<SVGPathElement>(null);
  const ears = useRef<Array<SVGPathElement | null>>([]);
  const rootRef = useRef<HTMLSpanElement>(null);
  const shown = useRef<{ eyes: string; gaze: string; ears: number[]; earTarget: number[]; rise: number; sink: number }>({ eyes: "", gaze: "", ears: [], earTarget: [], rise: 0, sink: 0 });
  const earTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const still = useRef(reduced);
  still.current = reduced;

  const draw = (s: GlanceState, swapLid = 0) => {
    const kind = s.kind;
    const [tx, ty] = glanceGaze(s);
    const [gx, gy] = sprite.clamp(gazeKind(kind), tx, ty);
    const lid = Math.max(glanceLid(s), swapLid);
    const eye = { k: kind, lid, lidB: 0 };
    const [l, r] = sprite.eyes(eye, eye, gx, gy);
    const key = `${l}|${r}`;
    const seen = shown.current;
    if (key !== seen.eyes) { seen.eyes = key; eyeL.current?.setAttribute("d", l); eyeR.current?.setAttribute("d", r); }
    const gaze = `translate(${r3(gx * unit)}px, ${r3(gy * unit)}px)`;
    if (gaze !== seen.gaze && eyesRef.current) { seen.gaze = gaze; eyesRef.current.style.transform = gaze; }
    if (rootRef.current) { rootRef.current.dataset.face = kind; rootRef.current.dataset.gaze = `${gx},${gy}`; }
    if (s.rise !== seen.rise && riseRef.current) {
      seen.rise = s.rise;
      riseRef.current.style.transitionDuration = `${s.riseMs}ms`;
      riseRef.current.style.transform = `translateY(${r3(-s.rise * unit)}px)`;
    }
    if (s.sink !== seen.sink && sinkRef.current) { seen.sink = s.sink; sinkRef.current.style.transform = `scale(${r3(1 + 0.025 * s.sink)}, ${r3(1 - 0.04 * s.sink)})`; }
    const [aL, aR] = glanceEars(s);
    seen.earTarget = sprite.layers.map((layer) => (layer.side < 0 ? aL : layer.side > 0 ? aR : (aR - aL) / 2));
    stepEars(still.current);
  };

  const stepEars = (instant: boolean) => {
    const seen = shown.current;
    if (earTimer.current) { clearTimeout(earTimer.current); earTimer.current = null; }
    let moving = false;
    sprite.layers.forEach((layer, i) => {
      const target = seen.earTarget[i] ?? 0, at = seen.ears[i];
      let next = target;
      // flicks come in small steps of their own; a change of resting angle glides there a step at a time
      if (!instant && at !== undefined && Math.abs(target - at) > 6.5) { next = at + Math.sign(target - at) * 3; moving = true; }
      if (next !== at) { seen.ears[i] = next; ears.current[i]?.setAttribute("d", layer.at(next)); }
    });
    if (moving) earTimer.current = setTimeout(() => { earTimer.current = null; stepEars(false); }, EAR_STEP_MS);
  };

  const live = useRef<{ player: Player; was: Player | null; changedAt: number; mood: WorkingMood } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visible = useRef(true);

  const tick = () => {
    timer.current = null;
    const l = live.current;
    if (!l || still.current) return;
    const at = now();
    let due = l.player.advance(at);
    const swapAt = l.changedAt + GLANCE_SWAP_S * 1000;
    let swapLid = 0;
    let state = l.player.state;
    if (l.was) {
      // until the middle of the glide the old face stays, then it changes behind a blink
      const d = (at - swapAt) / 1000;
      const old = l.was.state, cur = l.player.state;
      const differs = old.kind !== cur.kind || Math.abs(glanceLid(old) - glanceLid(cur)) > 0.2;
      if (d < 0) { state = { ...cur, kind: old.kind, lid: old.lid, lidOver: old.lidOver, gx: old.gx, gy: old.gy, holdX: old.holdX, holdY: old.holdY }; due = Math.min(due, l.was.advance(at)); }
      if (differs && Math.abs(d) < 0.09) swapLid = 1 - Math.abs(d) / 0.09;
      if (d >= 0.09) l.was = null;
      else due = Math.min(due, at + 30);
    }
    draw(state, swapLid);
    if (!visible.current || due === Infinity) return;
    timer.current = setTimeout(tick, Math.max(16, due - at));
  };

  useClientLayoutEffect(() => {
    const at = now();
    if (reduced) {
      live.current = null;
      draw(stillOf(mood));
      return;
    }
    const l = live.current;
    if (!l) {
      const player = new Player(mood, seed, at);
      // it opens its eyes as it arrives
      player.state.wake = 1;
      live.current = { player, was: null, changedAt: -Infinity, mood };
      const open = [[140, 0.67], [200, 0.33], [260, 0]] as const;
      for (const [ms, lid] of open) setTimeout(() => { if (live.current?.player === player) { player.state.wake = lid; if (!timer.current) tick(); else draw(player.state); } }, ms);
    } else if (l.mood !== mood) {
      live.current = { player: new Player(mood, seed, at), was: l.player, changedAt: at, mood };
    }
    if (timer.current) clearTimeout(timer.current);
    tick();
  }, [mood, reduced, seed, body]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // off screen it sleeps; back on screen it catches up to where the step would be
    const io = new IntersectionObserver(([entry]) => {
      visible.current = Boolean(entry?.isIntersecting);
      if (visible.current && !timer.current) tick();
      if (!visible.current && timer.current) { clearTimeout(timer.current); timer.current = null; }
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (earTimer.current) clearTimeout(earTimer.current);
    live.current = null;
  }, []);

  const view = `0 0 ${sprite.G} ${sprite.G}`;
  return (
    <span ref={rootRef} className="absolute" style={box} data-glance="">
      <span ref={sinkRef} className="glance-sink absolute inset-0">
        <span ref={riseRef} className="glance-rise absolute inset-0">
          <span className={reduced ? "absolute inset-0 origin-bottom" : "glance-breathe absolute inset-0"} style={reduced ? undefined : { animationDelay: `-${Math.round((seedNumber(seed) % 3800))}ms` }}>
            <svg width={box.width} height={box.height} viewBox={view} shapeRendering="crispEdges" overflow="visible" className="absolute inset-0">
              {sprite.layers.map((layer, i) => <path key={i} ref={(el) => { ears.current[i] = el; }} d={layer.at(0)} fill={ink} />)}
              <path d={sprite.base} fill={ink} />
            </svg>
            <span ref={eyesRef} className="glance-eyes absolute inset-0">
              <svg width={box.width} height={box.height} viewBox={view} shapeRendering="crispEdges" overflow="visible" className="absolute inset-0">
                <path ref={eyeL} fill={eyeInk} />
                <path ref={eyeR} fill={eyeInk} />
              </svg>
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}

function seedNumber(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h >>> 0;
}
