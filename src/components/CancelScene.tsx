import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import day from "@/assets/cancel/desk-day.webp";
import dusk from "@/assets/cancel/desk-dusk.webp";
import night from "@/assets/cancel/desk-night.webp";
import { MASCOT_INK, type MausColor } from "@/lib/mascot";
import { createPixel, type PixelState } from "@/pixel/engine";
import { duskBody } from "../../shared/body-migration";

export type SceneTime = "day" | "dusk" | "night";
export interface SceneBot { id: string; color: string; body: string | null }

const SCENE: Record<SceneTime, string> = { day, dusk, night };
/** the bench's open stretch between the letters and the calendar holds four bots side by side, as shares of the scene's width */
const BENCH_MIDDLE = 0.46, BENCH_STEP = 0.08, BENCH_ROOM = 4;
export function benchSpots(count: number): number[] {
  const n = Math.min(count, BENCH_ROOM);
  return Array.from({ length: n }, (_, i) => BENCH_MIDDLE + (i - (n - 1) / 2) * BENCH_STEP);
}
/** the bench top's line, from the scene's bottom edge */
const BENCH_LINE = "19.6%";

const ink = (color: string) => Object.hasOwn(MASCOT_INK, color) ? MASCOT_INK[color as MausColor] : MASCOT_INK.blue;

/** one real pixel bot in its own colour and body */
export function SceneSprite({ bot, size, state }: { bot: SceneBot; size: number; state: PixelState }) {
  const el = useRef<HTMLSpanElement>(null);
  const body = duskBody(bot.body);
  useLayoutEffect(() => {
    if (!el.current || size <= 0) return;
    const made = createPixel(el.current, { body, size, colour: ink(bot.color), state });
    return () => made.destroy();
  }, [body, bot.color, size, state]);
  return <span ref={el} aria-hidden="true" style={{ position: "relative", display: "inline-block", flexShrink: 0, width: size, height: size }} />;
}

/** the cancel flow's pixel desk at a time of day, with the person's own bots standing on the bench */
export function CancelScene({ time, bots, state, className, children }: { time: SceneTime; bots: readonly SceneBot[]; state: PixelState; className?: string; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setWidth(node.clientWidth));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  const size = Math.max(20, Math.round(width * 0.074));
  const spots = benchSpots(bots.length);
  return (
    <div ref={box} data-cancel-scene={time} className={className} style={{ position: "relative", width: "100%", aspectRatio: "153 / 51", overflow: "hidden" }}>
      <img src={SCENE[time]} alt="" aria-hidden="true" draggable={false}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", imageRendering: "pixelated", pointerEvents: "none", userSelect: "none" }} />
      {width > 0 && spots.map((spot, index) => (
        <span key={bots[index]!.id} style={{ position: "absolute", left: `calc(${spot * 100}% - ${size / 2}px)`, bottom: BENCH_LINE }}>
          <SceneSprite bot={bots[index]!} size={size} state={state} />
        </span>
      ))}
      {children}
    </div>
  );
}
