import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight } from "@/icons";
import booksArt from "@/assets/pixel-art/books.webp";
import clockArt from "@/assets/pixel-art/clock.webp";
import computerArt from "@/assets/pixel-art/computer.webp";
import keyArt from "@/assets/pixel-art/key.webp";
import plugArt from "@/assets/pixel-art/plug.webp";
import { CancelScene, SceneSprite } from "@/components/CancelScene";
import type { AccountRecap } from "../../../../shared/account-recap";
import { useCloud } from "../data/cloud";
import type { PlanCatalog, Selection } from "../data/contracts";
import { bundleOf, priceCart } from "../data/pricing";
import { useAccountUsage } from "../data/usage";
import { useRecap } from "../data/recap";
import { useSession } from "../data/session";
import type { CancelAnswer, RetentionInput, RetentionOfferShown } from "../data/wire";
import { longDate, MONTH_NAMES } from "../lib/format";
import { Link } from "../lib/router";
import { Choice, Modal } from "../ui/controls";
import { Button, cx, Skeleton } from "../ui/kit";
import { cartText, planSelection } from "./plan-sheet";

export const CONTACT = "mailto:hello@dusk.bot";

/** the reasons in the order they are offered; one is needed, and "prefer not to say" counts */
export const REASONS: Array<{ id: CancelAnswer; label: string }> = [
  { id: "price", label: "it's too expensive" },
  { id: "unused", label: "i'm not using it enough" },
  { id: "feature", label: "it's missing a feature i need" },
  { id: "switching", label: "i'm switching to something else" },
  { id: "broken", label: "i'm having technical problems" },
  { id: "skip", label: "prefer not to say" },
];
/** the paid plans keep a dusk cloud's files this many days after the plan ends, then delete them */
export const KEPT_DAYS = 30;
const DAY = 86_400_000;

/** the one offer a reason gets: only what this plan can really take */
export function offerFor(reason: CancelAnswer | null, can: { cheaper: boolean }): RetentionOfferShown {
  if (reason === "price" || reason === "unused") return can.cheaper ? "downgrade" : "none";
  if (reason === "broken") return "help";
  if (reason === "feature") return "note";
  if (reason === "switching" || reason === "skip") return "losses";
  return "none";
}

export type FlowStep = "recap" | "reason" | "offer" | "losses" | "confirm" | "done";

/** the screens a reason walks through; "what you'd lose" is its own screen, so the reasons whose one offer is that list skip the offer screen */
export function stepsFor(shown: RetentionOfferShown): FlowStep[] {
  return ["recap", "reason", ...(shown === "losses" ? [] : ["offer" as const]), "losses", "confirm"];
}

export type LossIcon = "bots" | "routines" | "apps" | "memory" | "work";
const LOSS_ART: Record<LossIcon, string> = { bots: computerArt, routines: clockArt, apps: plugArt, memory: booksArt, work: keyArt };

/** "Nova, Quill and Rivet", "Nova, Quill, Rivet and 2 more" */
export function botNames(names: readonly string[], total: number): string {
  const shown = names.slice(0, total > 4 ? 3 : 4);
  const more = total - shown.length;
  if (!shown.length) return total === 1 ? "your bot" : total > 1 ? `your ${total} bots` : "your bots";
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** what ends with the plan, in the person's own numbers and names when known; `keepsLicense` is a work license that outlives the dusk cloud */
export function losses(opts: { desk: boolean; work: boolean; keepsLicense: boolean; keptUntil: string; recap?: AccountRecap | null }): Array<{ icon: LossIcon; text: string }> {
  const r = opts.recap;
  const bots = r?.bots ?? 0;
  const who = botNames(r?.crew.map((b) => b.name) ?? [], bots);
  const routines = r?.routines ?? 0;
  const apps = r?.apps ?? 0;
  return [
    ...(opts.desk ? [
      { icon: "bots" as const, text: `${who} ${bots === 1 ? "stops" : "stop"} working when your mac sleeps` },
      { icon: "routines" as const, text: routines > 1 ? `your ${routines} routines only run while your mac is awake` : routines === 1 ? "your routine only runs while your mac is awake" : "routines only run while your mac is awake" },
      ...(apps > 0 ? [{ icon: "apps" as const, text: apps === 1 ? "the app they use only works while your mac is awake" : `the ${apps} apps they use only work while your mac is awake` }] : []),
      { icon: "memory" as const, text: `your dusk cloud's files, and what your bots remember there, are kept until ${opts.keptUntil}, then deleted` },
    ] : []),
    ...(opts.work && !opts.keepsLicense ? [{ icon: "work" as const, text: "work use is no longer covered. personal use stays free." }] : []),
  ];
}

function LossList({ rows }: { rows: Array<{ icon: LossIcon; text: string }> }) {
  if (!rows.length) return null;
  return (
    <ul className="mt-4 flex flex-col gap-1">
      {rows.map((row) => (
        <li key={row.text} data-loss={row.icon} className="flex min-h-12 items-center gap-3.5 text-14 text-ink-2">
          <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-card"><img src={LOSS_ART[row.icon]} alt="" draggable={false} className="max-h-7 max-w-7 object-contain [image-rendering:pixelated]" /></span>
          <span className="min-w-0">{row.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** where the person is in the flow: one dot a screen, the current one long */
function Dots({ steps, at }: { steps: FlowStep[]; at: FlowStep }) {
  const index = steps.indexOf(at);
  return (
    <div role="img" aria-label={`step ${index + 1} of ${steps.length}`} data-dots={`${index + 1}/${steps.length}`} className="flex items-center gap-1.5">
      {steps.map((step, i) => <span key={step} aria-hidden className={cx("h-1.5 rounded-full transition-[width,background-color] duration-200 ease-out", i === index ? "w-5 bg-ink" : i < index ? "w-1.5 bg-ink-3" : "w-1.5 bg-track")} />)}
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");
const monthYear = (t: number) => { const d = new Date(t); return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`; };

/** the numbers worth showing, biggest story first; zeros say nothing, so they are left out */
export function recapStats(r: AccountRecap): Array<{ id: string; value: string; label: string }> {
  return [
    { id: "replies", n: r.replies, label: r.replies === 1 ? "reply from your bots" : "replies from your bots" },
    { id: "days", n: r.activeDays, label: r.activeDays === 1 ? "day you worked together" : "days you worked together" },
    { id: "streak", n: r.longestStreak > 1 ? r.longestStreak : 0, label: "days in a row, your best streak" },
    { id: "routines", n: r.routines, label: r.routines === 1 ? "routine on a schedule" : "routines on a schedule" },
    { id: "apps", n: r.apps, label: r.apps === 1 ? "app connected" : "apps connected" },
    { id: "bots", n: r.bots, label: r.bots === 1 ? "bot you made" : "bots you made" },
  ].filter((s) => s.n > 0).map((s) => ({ id: s.id, value: fmt(s.n), label: s.label }));
}

function Recap({ recap, loading }: { recap: AccountRecap | null; loading: boolean }) {
  const stats = recap ? recapStats(recap) : [];
  const top = recap?.topBot ?? null;
  return (
    <>
      <p>{recap?.since ? `you've been at it together since ${monthYear(recap.since)}. before you go, here's what that added up to.` : "before you go, here's what you and your bots did together."}</p>
      {loading ? (
        <div className="mt-5 grid grid-cols-3 gap-2 max-sm:grid-cols-2" aria-busy="true" aria-label="loading">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-[84px] !rounded-[16px]" />)}</div>
      ) : stats.length ? (
        <dl className="mt-5 grid grid-cols-3 gap-2 max-sm:grid-cols-2">
          {stats.map((s) => (
            <div key={s.id} data-stat={s.id} className="flex flex-col-reverse justify-end gap-1 rounded-[16px] bg-card px-4 py-3.5">
              <dt className="text-13 leading-[17px] text-ink-3">{s.label}</dt>
              <dd className="num text-24 font-medium tracking-[-0.03em] text-ink">{s.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-3">your bots are set up and ready whenever you are.</p>
      )}
      {top && !loading && (
        <p data-top-bot className="mt-4 flex items-center gap-3 text-14 text-ink-2">
          <SceneSprite bot={top} size={28} state="happy" />
          <span><span className="text-ink">{top.name}</span> did the most: {fmt(top.replies)} {top.replies === 1 ? "reply" : "replies"}.</span>
        </p>
      )}
    </>
  );
}

function HelpLink({ to, external, onClick, children }: { to: string; external?: boolean; onClick(): void; children: ReactNode }) {
  const cls = "hover-row flex min-h-12 items-center justify-between gap-3 rounded-[14px] bg-card px-3.5 text-14 text-ink";
  return external
    ? <a href={to} className={cls} onClick={onClick}>{children}<ArrowUpRight size={15} strokeWidth={1.5} className="shrink-0 text-ink-3" aria-hidden /></a>
    : <Link to={to} className={cls} onClick={onClick}>{children}<ArrowUpRight size={15} strokeWidth={1.5} className="shrink-0 text-ink-3" aria-hidden /></Link>;
}

/** what the bots did this month */
function Unused() {
  const { month, bots, loading } = useAccountUsage();
  const turns = month?.totals.turns ?? 0;
  return <p>{loading ? "checking what your bots did..." : turns > 0 ? `this month your ${bots.length === 1 ? "bot" : `${bots.length} bots`} took ${turns.toLocaleString("en-US")} turns.` : "your bots haven't done much this month."}</p>;
}

/** the smaller plan, for someone on pro */
function Smaller({ plus, smaller, work, busy, onDowngrade, catalog, interval }: { plus: { name: string }; smaller: Selection; work: boolean; busy: string | null; onDowngrade(): void; catalog: PlanCatalog; interval: Selection["interval"] }) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-card px-4 py-3">
      <div className="min-w-0 flex-1 basis-[200px]">
        <p className="text-14 text-ink">switch to {plus.name}</p>
        <p className="num text-13 text-ink-3">{cartText(priceCart(smaller, catalog), interval)}, a smaller dusk cloud{work ? ", work license included" : ""}</p>
      </div>
      <Button variant="primary" size="sm" onClick={onDowngrade} disabled={busy !== null}>{busy === "downgrade" ? "changing" : "continue to change plan"}</Button>
    </div>
  );
}

/** account, plan & billing, cancel subscription: a look back at what they and their bots did, why, the one offer that fits,
 * what they'd lose, then the cancel at the period's end. consumer rules (California's online cancel, ROSCA, UK, EU) want it
 * online and plain: every screen has a way on toward the cancel, a reason is asked but "prefer not to say" counts, and there is
 * at most one offer */
export function CancelFlow({ open, onClose, catalog }: { open: boolean; onClose(): void; catalog: PlanCatalog }) {
  const { billing, cancel, keep: renew, changePlan, updateCard, retentionStep } = useCloud();
  const { toast } = useSession();
  const { recap, loading } = useRecap(open);
  const noteId = useId();
  const [step, setStep] = useState<FlowStep>("recap");
  const [reason, setReason] = useState<CancelAnswer | null>(null);
  const [missing, setMissing] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"downgrade" | "cancel" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // what was cancelled, as it was: a dusk cloud cancelled alone changes the plan it is read from
  const [ended, setEnded] = useState<{ sel: Selection; keepsLicense: boolean } | null>(null);
  // the dialog refocuses whenever its onClose changes, so it gets one that never does
  const closeRef = useRef(onClose);
  const dismiss = useCallback(() => closeRef.current(), []);
  const seen = useRef(step);
  useEffect(() => {
    if (seen.current === step) return;
    seen.current = step;
    document.querySelector<HTMLElement>("[role=dialog]")?.focus();
  }, [step]);
  const sub = billing?.subscription;
  if (!sub) return null;
  const sel = ended?.sel ?? sub.selection;
  const desk = sel.desktop !== "none";
  const work = sel.license !== "personal";
  // a plan change on a trial ends the trial and bills at once, so a trial cancel always ends the whole plan
  const trial = sub.trialEndsAt !== undefined && sub.trialEndsAt > Date.now();
  const keepsLicense = ended?.keepsLicense ?? (work && desk && !trial);
  const onPro = sel.desktop === bundleOf(catalog, "pro")?.desktop;
  const plus = bundleOf(catalog, "starter");
  const smaller: Selection = planSelection(catalog, "starter", { interval: sel.interval, region: sel.region, work: false, keep: sel });
  const until = longDate(sub.currentPeriodEnd);
  const keptUntil = longDate(sub.currentPeriodEnd + KEPT_DAYS * DAY);
  const cheaper = onPro && plus && !trial ? plus : null;
  const shown = offerFor(reason, { cheaper: Boolean(cheaper) });
  const steps = stepsFor(shown);
  const said = note.trim();
  const crew = recap?.crew ?? [];

  const log = (s: RetentionInput["step"], outcome: RetentionInput["outcome"]) => {
    if (reason) retentionStep({ reason, step: s, outcome, offer: shown, ...(said && outcome !== "shown" ? { note: said } : {}) });
  };
  const helped = () => log("help", "helped");
  // "what you'd lose" is the offer itself for the reasons whose offer it is, else it belongs with the confirm
  const lossesStep: RetentionInput["step"] = shown === "losses" ? "help" : "confirm";
  const keep = () => {
    if (step !== "done" && step !== "recap") log(step === "reason" ? "reason" : step === "offer" ? "help" : step === "losses" ? lossesStep : "confirm", "kept");
    onClose();
  };
  const go = (to: FlowStep) => { setError(null); setStep(to); };
  const next = () => {
    if (step === "recap") return go("reason");
    if (step === "reason") {
      if (!reason) { setMissing(true); return; }
      log("reason", "shown");
      return go(steps[steps.indexOf("reason") + 1]!);
    }
    if (step === "offer") { log("help", "shown"); return go("losses"); }
    if (step === "losses") { if (shown === "losses") log("help", "shown"); return go("confirm"); }
  };
  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>, after: () => void = onClose) => {
    setBusy(kind); setError(null);
    try { await action(); after(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const downgrade = () => run("downgrade", async () => {
    await changePlan(smaller, 0);
    log("help", "downgrade");
    toast(`you switch to ${plus?.name ?? "plus"} on ${until}. until then nothing changes.`);
  });
  const stop = () => run("cancel", async () => {
    setEnded({ sel, keepsLicense });
    if (keepsLicense) { await changePlan({ ...sel, desktop: "none", size: null }); log("confirm", "cancelled"); }
    else await cancel(reason ? { answer: reason, offer: shown, ...(said ? { improve: said } : {}) } : null);
  }, () => go("done"));
  const restart = () => run("restart", async () => {
    if (keepsLicense) await changePlan(sel, 0); else await renew();
    if (reason) retentionStep({ reason, step: "confirm", outcome: "kept", offer: shown });
    toast(`your plan renews again on ${until}`);
  });

  const title = step === "recap" ? "look what you and your bots did"
    : step === "reason" ? "why are you leaving?"
      : step === "offer" ? (reason === "unused" ? "your bots this month" : shown === "downgrade" ? "keep it for less" : reason === "broken" ? "let's fix it" : reason === "feature" ? "tell us what's missing" : "free stays free")
        : step === "losses" ? "what you'd lose"
          : step === "confirm" ? (keepsLicense ? "cancel your dusk cloud?" : "cancel your plan?")
            : keepsLicense ? "your dusk cloud is cancelled" : "your plan is cancelled";
  const saves = cheaper && <Smaller plus={cheaper} smaller={smaller} work={work} busy={busy} onDowngrade={() => void downgrade()} catalog={catalog} interval={sel.interval} />;
  const keepButton = <Button variant="primary" onClick={keep}>keep my plan</Button>;
  const onwardLabel = step === "offer" ? "no thanks, continue" : step === "losses" ? "i understand, continue" : keepsLicense ? "continue to cancel dusk cloud" : "continue to cancel";
  const footer = step === "done"
    ? <><Button onClick={() => void restart()} disabled={busy !== null}>{busy === "restart" ? "resuming" : "resume my plan"}</Button><Button variant="primary" onClick={onClose}>done</Button></>
    : step === "confirm"
      ? <><Button onClick={() => void stop()} disabled={busy !== null}>{busy === "cancel" ? "cancelling" : keepsLicense ? "cancel dusk cloud" : "cancel subscription"}</Button>{keepButton}</>
      : <><Button onClick={next} disabled={busy !== null}>{onwardLabel}</Button>{keepButton}</>;
  const dots = step === "done" ? null : <Dots steps={steps} at={step} />;
  const pad = "px-7 max-sm:px-5";
  const top = step === "recap" ? <><CancelScene time="day" bots={crew} state="working" /><div className={cx(pad, "pt-6 max-sm:pt-5")}>{dots}</div></>
    : step === "losses" && desk ? <><CancelScene time="dusk" bots={crew} state="sad" /><div className={cx(pad, "pt-6 max-sm:pt-5")}>{dots}</div></>
      : step === "done" ? <CancelScene time="night" bots={recap?.topBot ? [recap.topBot] : crew.slice(0, 1)} state="happy" />
        : <div className={cx(pad, "pt-7 max-sm:pt-5")}>{dots}</div>;

  closeRef.current = step === "done" ? onClose : keep;

  return (
    <Modal open={open} onClose={dismiss} title={title} footer={footer} wide top={top}>
      {step === "recap" && <Recap recap={recap} loading={loading} />}

      {step === "reason" && (
        <>
          <p>pick the closest one. it helps us fix the right thing.</p>
          <fieldset className="mt-4 min-w-0">
            <legend className="sr-only">reason</legend>
            <div className="flex flex-col gap-1">
              {REASONS.map((r) => <Choice key={r.id} name="cancel-reason" value={r.id} checked={reason === r.id} onChange={() => { setReason(r.id); setMissing(false); }} title={r.label} />)}
            </div>
          </fieldset>
          {missing && <p role="alert" className="mt-2 text-13 text-bad">pick one, or choose prefer not to say.</p>}
          <label htmlFor={noteId} className="mt-4 mb-1.5 block text-13 text-ink-2">anything else you'd like us to know? (optional)</label>
          <textarea id={noteId} value={note} maxLength={2000} rows={2} onChange={(e) => setNote(e.target.value)} className="field !h-auto min-h-[72px] resize-y !py-3 !text-14" />
          {sub.status === "past_due" && <button type="button" className="text-link mt-3 h-9 text-13" onClick={() => void updateCard()}>update your card instead</button>}
        </>
      )}

      {step === "offer" && (
        <>
          {reason === "unused" ? (
            <div><Unused />{shown === "downgrade" ? <><p className="mt-4">or keep it for less:</p>{saves}</> : <p className="mt-3">personal use on your mac stays free, so your bots can keep running there at no cost.</p>}</div>
          ) : shown === "downgrade" ? (
            <><p>your plan can cost less, if you'd like to stay.</p>{saves}</>
          ) : reason === "price" ? (
            <p>you're on our smallest plan. personal use on your mac stays free, so your bots keep running there at no cost.</p>
          ) : reason === "broken" ? (
            <>
              <p>most problems clear up with a restart, and we answer every message.</p>
              <div className="mt-4 flex flex-col gap-1.5">
                {desk && <HelpLink to="/cloud" onClick={helped}>restart your dusk cloud</HelpLink>}
                <HelpLink to="/workspaces" onClick={helped}>check that your computers are connected</HelpLink>
                <HelpLink to={`${CONTACT}?subject=${encodeURIComponent("something broke")}${said ? `&body=${encodeURIComponent(said)}` : ""}`} external onClick={helped}>tell us what broke at hello@dusk.bot</HelpLink>
              </div>
            </>
          ) : (
            <>
              <p>tell us and we'll reply. it may already be there, or be close.</p>
              <div className="mt-4 flex flex-col gap-1.5">
                <HelpLink to="/connectors" onClick={helped}>see the apps your bots can use</HelpLink>
                <HelpLink to={`${CONTACT}?subject=${encodeURIComponent("a missing feature")}${said ? `&body=${encodeURIComponent(said)}` : ""}`} external onClick={helped}>tell us what's missing at hello@dusk.bot</HelpLink>
              </div>
            </>
          )}
        </>
      )}

      {step === "losses" && (
        <>
          <p>{keepsLicense ? `your dusk cloud keeps working until ${until} and your work license stays. after that:` : `everything keeps working until ${until}. after that:`}</p>
          <LossList rows={losses({ desk, work, keepsLicense, keptUntil, recap })} />
        </>
      )}

      {step === "confirm" && (
        <>
          <p>{keepsLicense ? `your dusk cloud ends on ${until}, not today. it keeps working until then and isn't charged again. your work license stays and keeps renewing.`
            : `your plan ends on ${until}, not today. everything keeps working until then, and you won't be charged${trial ? "" : " again"}.`}</p>
          <p className="mt-3">{desk ? `your dusk cloud's files are kept until ${keptUntil}. ` : ""}you can resume any time before {until}.</p>
        </>
      )}

      {step === "done" && (
        <p role="status">{keepsLicense ? `your dusk cloud works until ${until} and isn't charged again.` : `you have access until ${until}.`} resume any time before then and nothing changes.</p>
      )}
      {error && <p role="alert" className="mt-3 text-13 text-bad">{error}</p>}
    </Modal>
  );
}
