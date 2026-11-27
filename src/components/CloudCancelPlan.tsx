import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, X } from "../icons";
import booksArt from "@/assets/pixel-art/books.webp";
import clockArt from "@/assets/pixel-art/clock.webp";
import computerArt from "@/assets/pixel-art/computer.webp";
import plugArt from "@/assets/pixel-art/plug.webp";
import type { AccountRecap } from "../../shared/account-recap";
import { CancelScene, SceneSprite } from "./CancelScene";

import type { CloudCancelAnswer, CloudCancelSurvey, CloudRenewalResult, CloudRetentionOffer, CloudRetentionStep } from "../../electron/cloud-account.mjs";
import type { CloudUsage } from "../../electron/cloud-home.mjs";
import type { CloudRenewal } from "../../electron/cloud-list.mjs";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { meterAmounts, meterLabel } from "@/lib/usage-meter";
import type { LocaleKey } from "@/locales";

/** The six reasons the sheet asks, in this order; an older answer (setup, later, other) is never offered again. */
const ANSWERS = ["price", "unused", "feature", "switching", "broken", "skip"] as const satisfies readonly CloudCancelAnswer[];
type Answer = (typeof ANSWERS)[number];
const ANSWER_LABEL: Record<Answer, LocaleKey> = {
  price: "cloudCancel.answer.price", unused: "cloudCancel.answer.unused", feature: "cloudCancel.answer.feature",
  switching: "cloudCancel.answer.switching", broken: "cloudCancel.answer.broken", skip: "cloudCancel.answer.skip",
};
const BOX_MAX = 2_000, DAY_MS = 86_400_000;
export const CANCEL_HELP_URL = "https://dusk.bot/support";
export const CANCEL_MAIL = "hello@dusk.bot";

/** Main cancels and keeps the plan; the page only says what the person answered. `retention` logs a step for the save rate
 * (best effort, absent on an older app). */
export interface CloudRenewalActions {
  cancel(survey: CloudCancelSurvey | null): Promise<CloudRenewalResult>;
  keep(): Promise<CloudRenewalResult>;
  retention?(step: CloudRetentionStep): Promise<boolean>;
}

/** What the one offer may use: this month's use of the plan, a cheaper plan to look at, and the browser. */
export interface CloudCancelOffers {
  usage?: CloudUsage | null;
  /** the name of a cheaper plan the person could move to (not on a trial), when there is one */
  cheaper?: string | null;
  openPlans?: () => Promise<unknown>;
  openLink?: (url: string) => Promise<unknown>;
  /** what the person and their bots did together, for the first screen and "what you'd lose"; null when it can't be read */
  recap?: () => Promise<AccountRecap | null>;
}

const day = (value: number) => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date(value));
const endsAt = (renewal: CloudRenewal) => renewal.endsAt ?? renewal.renewsAt;

export function endedLine(renewal: CloudRenewal): string {
  const at = endsAt(renewal);
  if (renewal.trial) return at ? t("cloudCancel.endedTrial", { date: day(at) }) : t("cloudCancel.endedTrialNoDate");
  return at ? t("cloudCancel.endedPlan", { date: day(at) }) : t("cloudCancel.endedPlanNoDate");
}

export function stopsLine(renewal: CloudRenewal): string {
  const stops = renewal.team ? t("cloudCancel.teamStops", { team: renewal.team }) : t("cloudCancel.stops");
  const kept = renewal.keptDays;
  if (kept === null) return stops;
  const files = kept <= 0 ? t("cloudCancel.keptNone") : !Number.isInteger(kept) ? t("cloudCancel.keptHours", { hours: Math.max(1, Math.round(kept * 24)) })
    : kept === 1 ? t("cloudCancel.keptDay") : t("cloudCancel.keptDays", { days: kept });
  return `${stops} ${files}`;
}

/** what stops with the plan: the team's cloud, the bots while the Mac sleeps, the routines */
export function lossLines(renewal: CloudRenewal): string[] {
  return [renewal.team ? t("cloudCancel.teamStops", { team: renewal.team }) : null, t("cloudCancel.lossBots"), t("cloudCancel.lossRoutines")].filter((line): line is string => line !== null);
}

/** when the files go, from the real end of the period and the days they are kept */
export function filesLine(renewal: CloudRenewal): string | null {
  const at = endsAt(renewal), kept = renewal.keptDays;
  if (kept === null) return null;
  if (kept <= 0) return t("cloudCancel.lossFilesNone");
  return at ? t("cloudCancel.lossFilesUntil", { date: day(at + kept * DAY_MS) }) : null;
}

/** what the bots used of the plan this month, one line a meter, the ones that moved */
function usedLines(usage: CloudUsage | null | undefined): string[] {
  return (usage?.meters ?? []).filter(meter => meter.kind !== "storage" && meter.used > 0).map(meter => `${meterLabel(meter.kind)}: ${meterAmounts(meter)}`);
}

const count = (value: number) => new Intl.NumberFormat(activeLocale()).format(value);
const monthYear = (value: number) => new Intl.DateTimeFormat(activeLocale(), { month: "long", year: "numeric" }).format(new Date(value));

/** "Nova, Quill and Rivet", "Nova, Quill, Rivet and 2 more", in the app's language */
export function botNames(names: readonly string[], total: number): string | null {
  const shown = names.slice(0, total > 4 ? 3 : 4);
  if (!shown.length) return null;
  const more = total - shown.length;
  return new Intl.ListFormat(activeLocale(), { type: "conjunction" }).format(more > 0 ? [...shown, t("cloudCancel.moreBots", { count: more })] : shown);
}

/** the recap's numbers worth showing, biggest story first; zeros say nothing, so they are left out */
export function recapStats(recap: AccountRecap): Array<{ id: string; value: string; label: string }> {
  const one = (n: number, many: LocaleKey, single: LocaleKey) => t(n === 1 ? single : many);
  return [
    { id: "replies", n: recap.replies, label: one(recap.replies, "cloudCancel.stat.replies", "cloudCancel.stat.replies.one") },
    { id: "days", n: recap.activeDays, label: one(recap.activeDays, "cloudCancel.stat.days", "cloudCancel.stat.days.one") },
    { id: "streak", n: recap.longestStreak > 1 ? recap.longestStreak : 0, label: t("cloudCancel.stat.streak") },
    { id: "routines", n: recap.routines, label: one(recap.routines, "cloudCancel.stat.routines", "cloudCancel.stat.routines.one") },
    { id: "apps", n: recap.apps, label: one(recap.apps, "cloudCancel.stat.apps", "cloudCancel.stat.apps.one") },
    { id: "bots", n: recap.bots, label: one(recap.bots, "cloudCancel.stat.bots", "cloudCancel.stat.bots.one") },
  ].filter(stat => stat.n > 0).map(stat => ({ id: stat.id, value: count(stat.n), label: stat.label }));
}

type LossIcon = "bots" | "routines" | "apps" | "memory" | "team";
const LOSS_ART: Record<LossIcon, string> = { bots: computerArt, routines: clockArt, apps: plugArt, memory: booksArt, team: computerArt };

/** what ends with the plan, in the person's own names and numbers when the recap has them */
export function lossRows(renewal: CloudRenewal, recap: AccountRecap | null): Array<{ icon: LossIcon; text: string }> {
  const names = recap ? botNames(recap.crew.map(bot => bot.name), recap.bots) : null;
  const routines = recap?.routines ?? 0, apps = recap?.apps ?? 0, at = endsAt(renewal), kept = renewal.keptDays;
  const files = kept === null ? null : kept <= 0 ? t("cloudCancel.lossFilesNone") : at ? t("cloudCancel.lossMemoryUntil", { date: day(at + kept * DAY_MS) }) : null;
  return [
    ...(renewal.team ? [{ icon: "team" as const, text: t("cloudCancel.teamStops", { team: renewal.team }) }] : []),
    { icon: "bots", text: names ? t(recap!.bots === 1 ? "cloudCancel.lossBotsNamed.one" : "cloudCancel.lossBotsNamed", { bots: names }) : t("cloudCancel.lossBots") },
    { icon: "routines", text: routines ? t(routines === 1 ? "cloudCancel.lossRoutinesCount.one" : "cloudCancel.lossRoutinesCount", { count: routines }) : t("cloudCancel.lossRoutines") },
    ...(apps ? [{ icon: "apps" as const, text: t(apps === 1 ? "cloudCancel.lossApps.one" : "cloudCancel.lossApps", { count: apps }) }] : []),
    ...(files ? [{ icon: "memory" as const, text: files }] : []),
  ];
}

type Screen = "recap" | "why" | "offer" | "losses" | "confirm";
/** the screens a reason walks through; switching and prefer not to say have no offer of their own, "what you'd lose" is theirs */
export function stepsFor(answer: Answer | null): Screen[] {
  return ["recap", "why", ...(answer === "switching" || answer === "skip" ? [] : ["offer" as const]), "losses", "confirm"];
}

type OfferView = { offer: CloudRetentionOffer; title: LocaleKey; body?: string; lines?: string[]; action: { label: LocaleKey; outcome: CloudRetentionStep["outcome"]; run?: () => Promise<unknown> } };

/** The one offer for the reason, only what this app can really do. */
export function offerFor(answer: Answer, renewal: CloudRenewal, offers: CloudCancelOffers, note: string): OfferView {
  const keep = { label: "cloudCancel.keep", outcome: "kept" } as const;
  switch (answer) {
    case "price": return offers.cheaper && offers.openPlans && !renewal.trial
      ? { offer: "downgrade", title: "cloudCancel.offer.cheaperTitle", body: t("cloudCancel.offer.cheaper", { plan: offers.cheaper }), action: { label: "cloudCancel.offer.seePlans", outcome: "helped", run: offers.openPlans } }
      : { offer: "help", title: "cloudCancel.offer.freeTitle", body: t("cloudCancel.help.price"), action: keep };
    case "unused": {
      const used = usedLines(offers.usage);
      return used.length
        ? { offer: "help", title: "cloudCancel.offer.usedTitle", body: t("cloudCancel.offer.used"), lines: used, action: keep }
        : { offer: "help", title: "cloudCancel.offer.moreTitle", body: t("cloudCancel.help.later"), action: keep };
    }
    case "feature": {
      const mail = `mailto:${CANCEL_MAIL}?${new URLSearchParams({ subject: t("cloudCancel.offer.mailSubject"), ...(note.trim() ? { body: note.trim() } : {}) }).toString().replace(/\+/g, "%20")}`;
      return { offer: "note", title: "cloudCancel.offer.featureTitle", body: t("cloudCancel.offer.feature"),
        action: { label: "cloudCancel.offer.tellUs", outcome: "helped", ...(offers.openLink ? { run: () => offers.openLink!(mail) } : {}) } };
    }
    case "broken": return { offer: "help", title: "cloudCancel.offer.brokenTitle", body: t("cloudCancel.offer.broken"),
      action: { label: "cloudCancel.offer.openHelp", outcome: "helped", ...(offers.openLink ? { run: () => offers.openLink!(CANCEL_HELP_URL) } : {}) } };
    case "switching": case "skip": return { offer: "losses", title: "cloudCancel.offer.lossesTitle", lines: [...lossLines(renewal), ...[filesLine(renewal)].filter((line): line is string => line !== null)], action: keep };
  }
}

/** Plan & billing's foot: a quiet Cancel subscription that opens the sheet, or, once cancelled, when it ends and Resume. */
export function CloudCancelPlan({ renewal, actions, offers = {}, onChanged }: { renewal: CloudRenewal | undefined; actions: CloudRenewalActions | null; offers?: CloudCancelOffers; onChanged?: () => void }) {
  const [opened, setOpened] = useState<CloudRenewal | null>(null);
  const [keeping, setKeeping] = useState(false), [note, setNote] = useState<"failed" | "browser" | null>(null);
  if (!renewal || !actions) return null;
  const keep = () => {
    setKeeping(true); setNote(null);
    void actions.keep().then(result => {
      if (result.outcome === "kept") onChanged?.();
      else setNote(result.outcome === "browser" ? "browser" : "failed");
    }, () => setNote("failed")).finally(() => setKeeping(false));
  };
  return <>
    {renewal.cancelled
      ? <div data-cloud-cancel="cancelled" className="flex flex-col items-start gap-2 self-start">
        <p role="status" className="text-[13px] text-ink">{endedLine(renewal)}</p>
        <button type="button" className="ui-button" disabled={keeping} onClick={keep}>{t(keeping ? "cloudCancel.keeping" : "cloudCancel.resume")}</button>
        {note && <p role={note === "failed" ? "alert" : "status"} className={cn("text-[13px]", note === "failed" ? "text-danger" : "text-ink-secondary")}>
          {t(note === "failed" ? "cloudCancel.failed" : "cloudCancel.browser")}</p>}
      </div>
      : <button type="button" data-cloud-cancel="renewing" onClick={() => { setNote(null); setOpened(renewal); }}
        className="self-start rounded-sm text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {t("cloudCancel.cancelSubscription")}</button>}
    {opened && <CloudCancelSheet renewal={opened} actions={actions} offers={offers} onClose={changed => { setOpened(null); if (changed) onChanged?.(); }} />}
  </>;
}

type Step = { step: Screen } | { step: "done"; renewal: CloudRenewal } | { step: "browser" };

/** one dot a screen, the current one long */
function Dots({ steps, at }: { steps: Screen[]; at: Screen }) {
  const index = steps.indexOf(at);
  return <div role="img" aria-label={t("cloudCancel.stepOf", { step: index + 1, count: steps.length })} data-cloud-cancel-dots={`${index + 1}/${steps.length}`} className="flex items-center gap-1.5">
    {steps.map((step, i) => <span key={step} aria-hidden="true" className={cn("h-1.5 rounded-full", i === index ? "w-5 bg-ink" : i < index ? "w-1.5 bg-ink/40" : "w-1.5 bg-ink/12")} />)}
  </div>;
}

export function CloudCancelSheet({ renewal, actions, offers = {}, onClose }: { renewal: CloudRenewal; actions: CloudRenewalActions; offers?: CloudCancelOffers; onClose: (changed: boolean) => void }) {
  const [picked, setPicked] = useState<Answer | null>(null), [missing, setMissing] = useState(false);
  const [note, setNote] = useState("");
  const [state, setState] = useState<Step>({ step: "recap" });
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const [recap, setRecap] = useState<{ value: AccountRecap | null; loading: boolean }>({ value: null, loading: Boolean(offers.recap) });
  const changed = useRef(false), dialog = useRef<HTMLDivElement>(null), named = useId();
  const loadRecap = offers.recap;
  useEffect(() => {
    if (!loadRecap) return;
    let alive = true;
    void loadRecap().catch(() => null).then(value => { if (alive) setRecap({ value: value ?? null, loading: false }); });
    return () => { alive = false; };
  }, [loadRecap]);
  const offer = picked && picked !== "switching" && picked !== "skip" ? offerFor(picked, renewal, offers, note) : null;
  const offerKind: CloudRetentionOffer | undefined = picked === "switching" || picked === "skip" ? "losses" : offer?.offer;
  const steps = stepsFor(picked);
  const log = (step: CloudRetentionStep["step"], outcome: CloudRetentionStep["outcome"]) => {
    const said = note.trim();
    void actions.retention?.({ reason: picked ?? "skip", step, outcome, ...(offerKind && step !== "reason" ? { offer: offerKind } : {}), ...(said ? { note: said.slice(0, BOX_MAX) } : {}) }).catch(() => false);
  };
  const close = () => { if (!busy) onClose(changed.current); };
  /** "what you'd lose" is the offer itself for the reasons that have no other, else it belongs with the confirm */
  const lossesStep: CloudRetentionStep["step"] = offerKind === "losses" ? "help" : "confirm";
  /** Keep my plan, from any screen before the cancel: nothing changed, so the sheet just closes; before a reason there is nothing to log */
  const stay = () => {
    if (busy) return;
    const at = state.step;
    if (picked && at !== "recap") log(at === "why" ? "reason" : at === "offer" ? "help" : at === "losses" ? lossesStep : "confirm", "kept");
    onClose(changed.current);
  };
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => { dialog.current?.querySelector<HTMLElement>("[data-cloud-cancel-first]")?.focus(); }, [state.step]);
  const run = (work: () => Promise<void>) => {
    setBusy(true); setFailed(false);
    void work().catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  const go = (step: Screen) => { setFailed(false); setState({ step }); };
  const next = () => {
    const at = state.step;
    if (at === "recap") return go("why");
    if (at === "why") {
      if (!picked) { setMissing(true); dialog.current?.querySelector<HTMLElement>("input[type=radio]")?.focus(); return; }
      log("reason", "shown");
      return go(steps[steps.indexOf("why") + 1]!);
    }
    if (at === "offer") { log("help", "shown"); return go("losses"); }
    if (at === "losses") { if (offerKind === "losses") log("help", "shown"); return go("confirm"); }
  };
  const take = () => {
    if (!offer) return;
    log("help", offer.action.outcome);
    if (offer.action.run) void offer.action.run().catch(() => {});
    onClose(changed.current);
  };
  const cancel = () => run(async () => {
    const said = note.trim();
    const result = await actions.cancel({ answer: picked ?? "skip", ...(offerKind ? { offer: offerKind } : {}), ...(said ? { improve: said } : {}) });
    if (result.outcome === "cancelled") {
      changed.current = true;
      setState({ step: "done", renewal: result.renewal ?? { ...renewal, cancelled: true, endsAt: renewal.renewsAt, renewsAt: null } });
    } else if (result.outcome === "browser") setState({ step: "browser" });
    else setFailed(true);
  });
  const resume = () => run(async () => {
    const result = await actions.keep();
    if (result.outcome === "kept") { changed.current = true; onClose(true); }
    else if (result.outcome === "browser") setState({ step: "browser" });
    else setFailed(true);
  });
  const at = endsAt(renewal);
  const crew = recap.value?.crew ?? [];
  const top = recap.value?.topBot ?? null;
  const stats = recap.value ? recapStats(recap.value) : [];
  const title = state.step === "recap" ? t("cloudCancel.recapTitle") : state.step === "why" ? t("cloudCancel.whyTitle") : state.step === "offer" && offer ? t(offer.title)
    : state.step === "losses" ? t("cloudCancel.offer.lossesTitle") : state.step === "done" ? t("cloudCancel.doneTitle") : state.step === "browser" ? t("cloudCancel.cancelSubscription")
      : t(renewal.trial ? "cloudCancel.titleTrial" : "cloudCancel.titlePlan");
  const alert = failed && <p role="alert" className="mt-3 text-[13px] text-danger">{t("cloudCancel.failed")}</p>;
  const box = "mt-1.5 w-full rounded-lg border border-transparent bg-inset px-3 py-2 text-[14px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60";
  const body = "text-[14px] leading-[1.55] text-ink-secondary";
  const keepButton = <button type="button" data-cloud-cancel-first className="ui-button ui-button-primary" disabled={busy} onClick={stay}>{t("cloudCancel.keep")}</button>;
  const onward = <button type="button" data-cloud-cancel-next className="ui-button" onClick={next}>{t("cloudCancel.continue")}</button>;
  const art = state.step === "recap" ? <CancelScene time="day" bots={crew} state="working" />
    : state.step === "losses" ? <CancelScene time="dusk" bots={crew} state="sad" />
      : state.step === "done" ? <CancelScene time="night" bots={top ? [top] : crew.slice(0, 1)} state="happy" /> : null;
  const screen = state.step === "done" || state.step === "browser" ? null : state.step;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="cloud-cancel-title" aria-busy={busy} tabIndex={-1} data-cloud-cancel-sheet={state.step}
        data-cloud-cancel-offer={state.step === "offer" ? offer?.offer : undefined}
        className="relative flex max-h-[90vh] w-full max-w-[500px] flex-col overflow-hidden rounded-2xl border border-transparent bg-panel text-ink shadow-2xl outline-none"
        onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); close(); }
          if (event.key === "Tab") {
            const controls = [...dialog.current?.querySelectorAll<HTMLElement>("a[href], textarea:enabled, button:enabled, input:enabled") ?? []]
              .filter(control => !(control instanceof HTMLInputElement && control.type === "radio" && !control.checked && control.name && dialog.current?.querySelector(`input[name="${control.name}"]:checked`)));
            if (!controls.length) return;
            const first = controls[0]!, last = controls[controls.length - 1]!;
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <button type="button" aria-label={t("cloudCancel.close")} disabled={busy} onClick={close}
          className={cn("absolute end-3 top-3 z-10 rounded-full p-1.5 focus-visible:outline-2 focus-visible:outline-focus", art ? "bg-panel/85 text-ink hover:bg-panel" : "text-ink-secondary hover:bg-raised")}><X size={18} /></button>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {art}
          <header className={cn("px-6", art ? "pt-5" : "pt-6")}>
            {screen && <Dots steps={steps} at={screen} />}
            <h2 id="cloud-cancel-title" className={cn("pe-8 text-[18px] font-semibold leading-[24px] tracking-[-0.01em]", screen && "mt-4")}>{title}</h2>
          </header>
          <div className="px-6 pb-6 pt-2">
            {state.step === "recap" && <>
              <p className={body}>{recap.value?.since ? t("cloudCancel.recapSince", { month: monthYear(recap.value.since) }) : t("cloudCancel.recapLead")}</p>
              {recap.loading
                ? <div aria-busy="true" className="mt-4 grid grid-cols-3 gap-2">{[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="h-[76px] animate-pulse rounded-xl bg-inset" />)}</div>
                : stats.length
                  ? <dl className="mt-4 grid grid-cols-3 gap-2 max-[420px]:grid-cols-2">
                    {stats.map(stat => <div key={stat.id} data-cloud-cancel-stat={stat.id} className="flex flex-col-reverse justify-end gap-0.5 rounded-xl bg-inset px-3.5 py-3">
                      <dt className="text-[12px] leading-[16px] text-ink-secondary">{stat.label}</dt>
                      <dd className="text-[22px] font-semibold leading-[28px] tracking-[-0.02em] text-ink tabular-nums">{stat.value}</dd>
                    </div>)}
                  </dl>
                  : <p className={cn(body, "mt-2")}>{t("cloudCancel.recapEmpty")}</p>}
              {top && !recap.loading && <p data-cloud-cancel-top className="mt-4 flex items-center gap-3 text-[13px] text-ink-secondary">
                <SceneSprite bot={top} size={26} state="happy" />
                <span>{t(top.replies === 1 ? "cloudCancel.topBot.one" : "cloudCancel.topBot", { bot: top.name, count: count(top.replies) })}</span>
              </p>}
              <div className="mt-6 flex flex-wrap justify-end gap-2">{keepButton}{onward}</div>
            </>}
            {state.step === "why" && <>
              <fieldset className="mt-1" aria-describedby={missing ? `${named}-missing` : undefined}>
                <legend className={body}>{t("cloudCancel.whyLegend")}</legend>
                <div className="mt-3 flex flex-col gap-1">
                  {ANSWERS.map(answer => <label key={answer} data-cloud-cancel-answer={answer}
                    className={cn("flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[14px] text-ink hover:bg-ink/[0.04] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus", picked === answer && "bg-ink/[0.06]")}>
                    <input type="radio" name={`${named}-answer`} value={answer} checked={picked === answer} onChange={() => { setPicked(answer); setMissing(false); }}
                      className="size-4 shrink-0 cursor-pointer accent-[var(--color-ink)] outline-none" />
                    {t(ANSWER_LABEL[answer])}
                  </label>)}
                </div>
              </fieldset>
              {missing && <p id={`${named}-missing`} role="alert" className="mt-2 text-[13px] text-danger">{t("cloudCancel.pickOne")}</p>}
              <label className="mt-4 block text-[13px] text-ink">{t("cloudCancel.note")} <span className="text-ink-secondary">{t("cloudCancel.optional")}</span>
                <textarea rows={2} maxLength={BOX_MAX} value={note} onChange={event => setNote(event.target.value)} className={box} /></label>
              <div className="mt-6 flex flex-wrap justify-end gap-2">{keepButton}{onward}</div>
            </>}
            {state.step === "offer" && offer && <>
              {offer.body && <p className={body}>{offer.body}</p>}
              {offer.lines && <ul className="mt-3 flex flex-col gap-1.5">{offer.lines.map(line => <li key={line} className="rounded-lg bg-inset px-3 py-2 text-[13px] text-ink">{line}</li>)}</ul>}
              <div className="mt-6 flex flex-wrap justify-end gap-2">
                <button type="button" data-cloud-cancel-first data-cloud-cancel-take className="ui-button ui-button-primary gap-1.5" onClick={take}>
                  {t(offer.action.label)}{offer.action.run && <ArrowUpRight size={13} aria-hidden="true" />}</button>
                {onward}
              </div>
            </>}
            {state.step === "losses" && <>
              <p className={body}>{at ? t("cloudCancel.lossesUntil", { date: day(at) }) : t("cloudCancel.confirmLoses")}</p>
              <ul className="mt-3 flex flex-col gap-1">
                {lossRows(renewal, recap.value).map(row => <li key={row.text} data-cloud-cancel-loss={row.icon} className="flex min-h-11 items-center gap-3 text-[13px] leading-[1.45] text-ink">
                  <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-inset"><img src={LOSS_ART[row.icon]} alt="" draggable={false} className="max-h-5 max-w-6 object-contain [image-rendering:pixelated]" /></span>
                  <span className="min-w-0">{row.text}</span>
                </li>)}
              </ul>
              <div className="mt-6 flex flex-wrap justify-end gap-2">{keepButton}{onward}</div>
            </>}
            {state.step === "confirm" && <>
              <p className={body}>{at ? t(renewal.trial ? "cloudCancel.confirmTrialOn" : "cloudCancel.confirmPlanOn", { date: day(at) }) : t("cloudCancel.accessNoDate")}</p>
              {alert}
              <div className="mt-6 flex flex-wrap justify-end gap-2">
                {keepButton}
                <button type="button" data-cloud-cancel-confirm className="ui-button border-transparent bg-danger text-white hover:brightness-110" disabled={busy} onClick={cancel}>
                  {t(busy ? "cloudCancel.cancelling" : "cloudCancel.cancelSubscription")}</button>
              </div>
            </>}
            {state.step === "done" && <>
              {(() => { const end = endsAt(state.renewal); return <p role="status" className="text-[14px] font-medium text-ink">{end ? t("cloudCancel.accessUntil", { date: day(end) }) : t("cloudCancel.accessNoDate")}</p>; })()}
              <p className={cn(body, "mt-1.5")}>{t("cloudCancel.resumeAnytime")}</p>
              {alert}
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <button type="button" className="ui-button" disabled={busy} onClick={resume}>{t(busy ? "cloudCancel.keeping" : "cloudCancel.resume")}</button>
                <button type="button" data-cloud-cancel-first className="ui-button ui-button-primary ms-auto" disabled={busy} onClick={close}>{t("cloudCancel.done")}</button>
              </div>
            </>}
            {state.step === "browser" && <>
              <p role="status" className={body}>{t("cloudCancel.browser")}</p>
              <div className="mt-6 flex justify-end"><button type="button" data-cloud-cancel-first className="ui-button ui-button-primary" onClick={close}>{t("cloudCancel.done")}</button></div>
            </>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
