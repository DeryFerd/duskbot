import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download } from "@/icons";
import { useCloud } from "../data/cloud";
import type { LicenseId, PlanCatalog } from "../data/contracts";
import { bundleOf, desktopOf, licenseMonthly, licenseOf } from "../data/pricing";
import { useCart } from "../data/quote";
import { useSession } from "../data/session";
import { track } from "../lib/analytics";
import { longDate, shortDate, usd } from "../lib/format";
import { navigate } from "../lib/router";
import { cx, SectionTitle, Skeleton } from "../ui/kit";
import { AnimatePresence } from "../ui/motion";
import { CancelFlow } from "./cancel-flow";
import { regionName } from "./cloud-bits";
import { CHECKOUT_SOON, checkoutDone } from "./cloud-offer";
import { PaymentNotice } from "./payment-notice";
import { cartText, LicenseSheet, money, planName, priceText } from "./plan-sheet";

export const members = (n: number) => `${n} ${n === 1 ? "member" : "members"}`;
export const quiet = "text-link inline-flex h-9 items-center rounded-full px-1 text-14 disabled:opacity-45 max-sm:h-11";

function Row({ k, children, action }: { k: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid min-h-14 grid-cols-[160px_minmax(0,1fr)_auto] items-center gap-4 py-2.5 text-14 max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-y-0.5">
      <dt className="text-ink-3 max-sm:col-span-2 max-sm:text-13">{k}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
      {action ? <dd className="justify-self-end">{action}</dd> : <dd aria-hidden />}
    </div>
  );
}

/** after a plan ended: the same plan checks out again in one tap, and a cloud whose data is still kept comes back with it */
function useRestart(catalog: PlanCatalog) {
  const { billing, checkout } = useCloud();
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ended = billing && !billing.subscription ? billing.ended ?? null : null;
  const go = () => {
    if (!ended || busy) return;
    if (catalog.checkoutOpen === false) { setError(CHECKOUT_SOON); return; }
    setBusy(true); setError(null);
    track({ name: "plan_chosen", props: { plan: ended.bundle ?? "custom", period: ended.selection.interval } });
    checkout({ source: "dash_billing", kind: "plan", selection: ended.selection, bundle: ended.bundle })
      .then((ok) => { if (ok) { toast(checkoutDone(catalog)); navigate("/cloud"); } else setError("checkout didn't open. try again."); })
      .finally(() => setBusy(false));
  };
  return { ended, busy, error, go };
}

/** account, plan & billing: the plan, its license, the card and the invoices, with the cancel at the very bottom */
export function PlanBilling() {
  const { catalog, billing } = useCloud();
  const ref = useRef<HTMLElement>(null);
  const ready = Boolean(catalog && billing);
  // the app links straight to /account#billing, before the account has loaded
  useEffect(() => { if (ready && location.hash === "#billing") ref.current?.scrollIntoView({ block: "start" }); }, [ready]);
  return (
    <section ref={ref} id="billing" className="mt-10 scroll-mt-20" aria-labelledby="billing-title">
      <SectionTitle id="billing-title">plan & billing</SectionTitle>
      {catalog && billing ? <Billing catalog={catalog} /> : <Skeleton className="h-60 !rounded-card" />}
    </section>
  );
}

function Billing({ catalog }: { catalog: PlanCatalog }) {
  const { billing, clouds, updateCard, changePlan, keep } = useCloud();
  const { toast } = useSession();
  const restart = useRestart(catalog);
  const [keeping, setKeeping] = useState(false);
  const [keepError, setKeepError] = useState<string | null>(null);
  const [licenseSheet, setLicenseSheet] = useState<{ license: LicenseId; members: number } | null>(null);
  const [flows, setFlows] = useState(0);
  const [flowOpen, setFlowOpen] = useState(false);
  const sub = billing?.subscription ?? null;
  const sel = sub?.selection ?? null;
  const { cart } = useCart(sel, catalog);
  const pm = billing?.paymentMethod;
  const invoices = billing?.invoices ?? [];
  const files = invoices.some((inv) => inv.url);
  const lic = sel ? licenseOf(catalog, sel.license) : null;
  const desk = sel && sel.desktop !== "none" ? desktopOf(catalog, sel.desktop) : null;
  const plan = sel && desk ? catalog.bundles.find((b) => b.desktop === sel.desktop && b.id !== "team")?.name ?? desk.name : "free";
  const renews = sub?.status === "past_due" && sub.fixBy ? null : sub ? (sub.cancelAt ? `ends ${longDate(sub.cancelAt)}` : `renews ${longDate(sub.currentPeriodEnd)}`) : null;
  const applied = billing?.retention?.applied ?? null;
  const openFlow = () => { setFlows((n) => n + 1); setFlowOpen(true); };
  const openLicense = () => setLicenseSheet({ license: sel && sel.license !== "personal" ? sel.license : "starter", members: sel?.members ?? 1 });
  const cancellable = Boolean(sub && !sub.cancelAt && sub.status !== "canceled");
  const resumable = Boolean(sub && sub.cancelAt && sub.status === "active");
  return (
    <>
      <PaymentNotice />
      <dl className="">
        <Row k="plan" action={restart.ended ? <button type="button" className={quiet} disabled={restart.busy} onClick={restart.go}>{restart.busy ? "opening checkout" : "restart plan"}</button> : undefined}>
          {restart.ended && <span className="num block truncate max-sm:whitespace-normal">{planName(catalog, restart.ended.bundle)}<span className="text-ink-3"> ended {longDate(restart.ended.endedAt)}</span></span>}
          {restart.error && <span role="alert" className="block text-13 text-bad">{restart.error}</span>}
          {!restart.ended && <span className="block truncate max-sm:whitespace-normal">{plan}{desk && sel ? <span className="text-ink-3">, {clouds?.[0]?.name ?? desk.name} in {regionName(catalog, sel.region)}</span> : <span className="text-ink-3">, your bots run on your mac</span>}</span>}
          {sub && <span className="num block truncate text-13 text-ink-3 max-sm:whitespace-normal">{cart ? `${cartText(cart, sub.selection.interval)}${renews ? " · " : ""}` : ""}{renews}{applied && !sub.cancelAt ? ` · ${applied.percent}% off for ${applied.cycles} months` : ""}</span>}
        </Row>
        {sub?.scheduled && (
          <Row k="next plan" action={<button type="button" className={quiet} disabled={keeping} onClick={() => {
            setKeeping(true); setKeepError(null);
            changePlan(sub.selection, 0).then(() => toast(`you stay on ${planName(catalog, sub.bundle)}`), (e: Error) => setKeepError(e.message)).finally(() => setKeeping(false));
          }}>{keeping ? "keeping" : `keep ${planName(catalog, sub.bundle)}`}</button>}>
            <span className="num block truncate max-sm:whitespace-normal">{planName(catalog, sub.scheduled.bundle)}<span className="text-ink-3">, from {longDate(sub.scheduled.at)} at {money(sub.scheduled.amountUsd)}{sub.scheduled.selection.interval === "year" ? "/yr" : "/mo"}</span></span>
            <span className="block text-13 text-ink-3">{keepError ? <span role="alert" className="text-bad">{keepError}</span> : `you keep ${planName(catalog, sub.bundle)} and its machine until then. nothing more is charged.`}</span>
          </Row>
        )}
        <Row k="license" action={<button type="button" className={quiet} onClick={openLicense}>{lic?.work ? "change" : "add"}</button>}>
          {lic?.work && sel ? <span className="block truncate max-sm:whitespace-normal">{lic.name} license<span className="num text-ink-3">, {members(sel.members)} · {bundleOf(catalog, "pro")?.license === sel.license && bundleOf(catalog, "pro")?.desktop === sel.desktop ? "included with pro" : priceText(licenseMonthly(lic, sel.members), sel.interval, catalog)}</span></span> : <span className="text-ink-3">personal use, free</span>}
        </Row>
        <Row k="payment method" action={sub && sub.status !== "canceled" && !(sub.status === "past_due" && sub.fixBy) ? <button type="button" className={quiet} onClick={() => void updateCard()}>update</button> : undefined}>
          {pm ? <span className="num">{pm.brand.toLowerCase()} •••• {pm.last4}<span className="text-ink-3">, expires {String(pm.expMonth).padStart(2, "0")}/{String(pm.expYear).slice(-2)}</span></span> : sub ? <span className="text-ink-3">the card you paid with</span> : <span className="text-ink-3">none yet. you add one at checkout.</span>}
        </Row>
      </dl>
      <h3 className="mt-6 mb-1 text-14 font-medium text-ink">invoices</h3>
      {invoices.length ? (
        <ul className="">
          {invoices.map((inv) => (
            <li key={inv.id} className="flex min-h-12 items-center gap-4 text-14">
              <span className="num w-16 shrink-0 text-ink-3">{shortDate(inv.date)}</span>
              <span className="min-w-0 flex-1 truncate text-ink">{inv.description}</span>
              {inv.status !== "paid" && <span className={cx("text-13", inv.status === "open" ? "text-warn" : "text-ink-3")}>{inv.status === "open" ? "due" : "refunded"}</span>}
              <span className="num text-ink-2">{usd(inv.amountUsd)}</span>
              {inv.url ? (
                <a href={inv.url} target="_blank" rel="noreferrer" aria-label={`download invoice ${inv.number}`} className="hover-ghost -me-2 grid size-9 shrink-0 place-items-center rounded-full text-ink-3 max-sm:size-11"><Download size={15} strokeWidth={1.5} /></a>
              ) : files ? <span className="-me-2 size-9 shrink-0 max-sm:size-11" aria-hidden /> : null}
            </li>
          ))}
        </ul>
      ) : <p className="py-3 text-14 text-ink-3">invoices show up here after your first payment.</p>}
      {cancellable && <button type="button" className={cx(quiet, "-ms-1 mt-4")} onClick={openFlow}>cancel subscription</button>}
      {resumable && sub && (
        <div className="mt-4">
          <button type="button" className={cx(quiet, "-ms-1")} disabled={keeping} onClick={() => {
            setKeeping(true); setKeepError(null);
            keep().then(() => toast(`your plan renews again on ${longDate(sub.currentPeriodEnd)}`), (e: Error) => setKeepError(e.message)).finally(() => setKeeping(false));
          }}>{keeping ? "restarting" : "restart plan"}</button>
          {keepError && <p role="alert" className="text-13 text-bad">{keepError}</p>}
        </div>
      )}
      <AnimatePresence>{licenseSheet && <LicenseSheet key="license" source="dash_license" start={licenseSheet} onClose={() => setLicenseSheet(null)} onNothingLeft={openFlow} />}</AnimatePresence>
      <CancelFlow key={flows} open={flowOpen} onClose={() => setFlowOpen(false)} catalog={catalog} />
    </>
  );
}
