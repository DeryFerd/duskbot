import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TurnPresence, TYPING_PHASE } from "../components/TurnPresence";
import { WorkingMascot } from "../components/WorkingMascot";
import { applyMotionSpeed } from "../lib/motion-speed";
import { applySkin, THEME_SKINS } from "../lib/skins";
import { workingMood } from "../lib/working-mood";
import type { WorkingLinePick } from "../lib/working-line";
import "../font-faces.css";
import "../styles.css";
import "../styles/motion.css";
import "../components/chat.css";

const VERSIONS: Array<{ pick: WorkingLinePick; title: string; line: string }> = [
  { pick: "restore", title: "1  Restore", line: "The earlier line brought back: faces look up one way, then the other, a soft bob, the slow sweeping shimmer. Every step now glides." },
  { pick: "drift", title: "2  Drift", line: "The calmest: it breathes, its eyes drift up and around while it thinks, slow blinks." },
  { pick: "ponder", title: "3  Ponder", line: "Thinking you can see: three small dots rise over its head while it tilts its head." },
  { pick: "rock", title: "4  Rock", line: "Livelier but soft: it lands with a little squash, rocks side to side while thinking, hops in place while writing." },
  { pick: "ellipsis", title: "5  Ellipsis", line: "A quiet mascot; the words carry the thinking with dots that fill in one by one. Comes in from a soft blur." },
  { pick: "glance", title: "6  Glance", line: "The face does the acting: eyes read, dart and look up to think; the body only breathes. Moved by CSS and timers." },
  { pick: "shipped", title: "Now", line: "What ships today, for comparison." },
];

const SEND_AT = 400;
const LINE_AT = SEND_AT + 120;
const STEPS: Array<{ at: number; phase: string; phrases: string[] }> = [
  { at: LINE_AT, phase: "friendly:thinking", phrases: ["Thinking"] },
  { at: 4000, phase: "friendly:web", phrases: ["Looking things up"] },
  { at: 9500, phase: TYPING_PHASE, phrases: ["Writing"] },
];
const REPLY_AT = 14_500;
const CYCLE_MS = 19_500;
const REPLY = "It moved to 9:40, gate B12. Your seat stayed the same, and the hotel shuttle still lines up with the new time.";
const BOT = { id: "lab", color: "green" as const };

function useCycle(): { start: number; elapsed: number } {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 50);
    return () => clearInterval(timer);
  }, []);
  return { start, elapsed: now - start };
}

function Turn({ pick, elapsed, start, seed }: { pick: WorkingLinePick; elapsed: number; start: number; seed: string }) {
  const sent = elapsed >= SEND_AT;
  const step = [...STEPS].reverse().find((s) => elapsed >= s.at);
  const visible = Boolean(step) && elapsed < REPLY_AT;
  const writing = step?.phase === TYPING_PHASE;
  const replied = elapsed >= REPLY_AT;
  const since = start + SEND_AT;
  return (
    <div className="flex min-h-[220px] flex-col gap-3 px-4 pb-4 pt-3">
      <div className="flex justify-end">
        {sent && <div style={{ animation: "chat-row-fade 280ms var(--dusk-ease-out) backwards" }} className="max-w-[85%] rounded-[20px] bg-[color-mix(in_srgb,var(--color-ink)_7%,transparent)] px-3.5 py-2 text-[14px] leading-[1.45] text-ink">is the friday flight still on time?</div>}
      </div>
      {replied && (
        <p className="m-0 text-[14px] leading-[1.55] text-ink">
          {REPLY.split(" ").map((word, i) => <span key={i} className="md-rv" style={{ "--rv": i, "--rv-step": "45ms" } as React.CSSProperties}>{word} </span>)}
        </p>
      )}
      <div className="turn-status-slot h-9 shrink-0">
        {(visible || replied) && <TurnPresence
          line={pick}
          simple
          wordsAtOnce
          visible={visible}
          seed={seed}
          since={since}
          phase={step?.phase ?? "friendly:thinking"}
          phrases={step?.phrases ?? ["Thinking"]}
          avatar={(shown) => <WorkingMascot line={pick} bot={BOT} size={26} seed={seed} mood={workingMood({ phase: shown && !shown.startsWith("label:") ? shown : writing ? TYPING_PHASE : step?.phase })} />}
        />}
      </div>
    </div>
  );
}

function Lab() {
  const params = new URLSearchParams(location.search);
  const dark = params.get("theme") === "dark";
  const [run, setRun] = useState(0);
  const [auto, setAuto] = useState(true);
  return (
    <div className="min-h-[100dvh] bg-app px-6 py-8 text-ink">
      <header className="mx-auto mb-6 max-w-[1400px]">
        <h1 className="m-0 text-[24px] font-semibold leading-tight">Working line lab</h1>
        <p className="mb-4 mt-2 max-w-[72ch] text-[15px] leading-[1.6] text-ink-secondary">
          Five versions of the mascot and words shown while dusk bot replies, all playing the same turn: you send, it shows it is working at once, the words change twice, then the reply streams in. Each version stays in one spot and moves smoothly the whole time.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="ui-pill min-h-11 px-5" onClick={() => setRun((n) => n + 1)}>Replay</button>
          <button type="button" className="ui-pill min-h-11 px-5" aria-pressed={auto} onClick={() => setAuto((on) => !on)}>{auto ? "Looping" : "Loop off"}</button>
          <a className="ui-pill min-h-11 px-5" href={dark ? "?" : "?theme=dark"}>{dark ? "Light" : "Dark"}</a>
        </div>
      </header>
      <main className="mx-auto grid max-w-[1400px] grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
        <Cycle key={run} auto={auto} onLoop={() => setRun((n) => n + 1)} />
      </main>
    </div>
  );
}

function Cycle({ auto, onLoop }: { auto: boolean; onLoop: () => void }) {
  const { start, elapsed } = useCycle();
  const [seed] = useState(() => String(Date.now()));
  useEffect(() => {
    if (auto && elapsed >= CYCLE_MS) onLoop();
  }, [auto, elapsed, onLoop]);
  return (
    <>
      {VERSIONS.map(({ pick, title, line }) => (
        <section key={pick} aria-label={title} className="rounded-[18px] bg-[color-mix(in_srgb,var(--color-ink)_3%,var(--color-app))]">
          <div className="px-4 pt-4">
            <h2 className="m-0 whitespace-pre text-[15px] font-semibold">{title}</h2>
            <p className="m-0 mt-1 min-h-[3lh] text-[13px] leading-[1.5] text-ink-secondary">{line}</p>
          </div>
          <Turn pick={pick} elapsed={elapsed} start={start} seed={`${seed}:${pick}`} />
        </section>
      ))}
    </>
  );
}

applySkin(new URLSearchParams(location.search).get("theme") === "dark" ? THEME_SKINS.dark : THEME_SKINS.light);
applyMotionSpeed(document.documentElement);
createRoot(document.getElementById("root")!).render(<Lab />);
