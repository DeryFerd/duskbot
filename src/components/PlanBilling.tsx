import { useState } from "react";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudTrial, CloudUsage } from "../../electron/cloud-home.mjs";
import type { CloudRenewal, CloudPayment } from "../../electron/cloud-list.mjs";
import { openExternalLink } from "@/lib/app-links";
import { cloudPlanLabel, cloudPlanLine, cloudPlanView, cloudTrialView, trialRunning } from "@/lib/cloud-plan";
import { continueInBrowser } from "@/lib/account-intent";
import { activeLocale, t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { CloudCancelPlan, type CloudCancelOffers, type CloudRenewalActions } from "./CloudCancelPlan";
import { cloudPlanChanged, useCloudPlanSnapshot } from "./CloudTrialNotice";
import { ItemRow, NavRow, useSubPage } from "./ListRows";
import { SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { useCloudPlan } from "./ProIntroduction";

export const PLAN_BILLING_PAGE = "plan-billing";

const day = (value: number) => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date(value));
/** a smaller plan to look at for "too expensive": Plus, from any bigger personal plan */
const cheaperThan = (tier: string | undefined) => tier && ["personal", "pro", "max"].includes(tier) ? cloudPlanLabel("starter") : null;

interface PlanBilling {
  line: string;
  tier?: string;
  trial?: CloudTrial;
  renewal?: CloudRenewal;
  payment?: CloudPayment;
  usage?: CloudUsage;
  actions: CloudRenewalActions | null;
  /** the account page's plan & billing, where the payment method and invoices are */
  openAccount: () => Promise<unknown>;
  openPlans?: () => Promise<unknown>;
}

function localPlan(account: CloudAccountState | null): PlanBilling | null {
  const bridge = window.duskDesktop?.cloudAccount;
  if (!bridge || account?.status !== "connected") return null;
  const view = cloudPlanView(account), line = cloudPlanLine(view);
  if (!line || (view.kind === "free" && !account.renewal && !account.payment)) return null;
  return {
    line, tier: account.entitlement?.tier, trial: account.trial, renewal: account.renewal, payment: account.payment, usage: account.usage,
    actions: bridge.cancelPlan && bridge.keepPlan ? { cancel: survey => bridge.cancelPlan!(survey), keep: () => bridge.keepPlan!(), ...(bridge.retention ? { retention: step => bridge.retention!(step) } : {}) } : null,
    openAccount: () => bridge.openPage ? bridge.openPage("billing") : continueInBrowser({ kind: "billing" }),
    ...(bridge.continueInBrowser ? { openPlans: () => bridge.continueInBrowser!({ kind: "upgrade" }) } : {}),
  };
}

function cloudPlan(plan: CloudPlanSnapshot | null): PlanBilling | null {
  const bridge = window.duskDesktop?.cloudPlan;
  if (!bridge || !plan || (plan.status !== "paid" && plan.status !== "attention" && !plan.renewal)) return null;
  const label = cloudPlanLabel(plan.tier);
  return {
    line: plan.status === "paid" ? t(trialRunning(plan.trial) ? "cloudAccount.trialPlan" : "cloudAccount.pro", { plan: label }) : t("cloudAccount.inactive", { plan: plan.tier ? label : "dusk cloud" }),
    tier: plan.tier, trial: plan.trial, renewal: plan.renewal, usage: plan.usage,
    actions: bridge.cancel && bridge.keep ? { cancel: survey => bridge.cancel!(survey), keep: () => bridge.keep!(), ...(bridge.retention ? { retention: step => bridge.retention!(step) } : {}) } : null,
    openAccount: () => bridge.openPage ? bridge.openPage("billing") : bridge.manage(),
  };
}

/** The plan this window may show under Settings > Account: this computer's own sign-in, or, in the Cloud's own window,
 * the Cloud's plan; null where there is none to show (signed out, free, a remote client). */
export function usePlanBilling(): PlanBilling | null {
  const { state } = useStore();
  const remote = window.duskDesktop?.remoteClient?.active === true;
  const local = useCloudPlan();
  const onCloud = !remote && !window.duskDesktop?.cloudAccount && state.config?.cloudHome === true && !state.config?.team ? window.duskDesktop?.cloudPlan : undefined;
  const snapshot = useCloudPlanSnapshot(onCloud);
  if (remote) return null;
  return local ? localPlan(local.account) : cloudPlan(snapshot);
}

/** Account's row that opens Plan & billing, only while there is a plan to show. */
export function PlanBillingRow() {
  const plan = usePlanBilling();
  const sub = useSubPage();
  if (!plan) return null;
  const title = t("settings.planBilling.title");
  return <NavRow data-settings-open={PLAN_BILLING_PAGE} data-panel-page={PLAN_BILLING_PAGE} title={title} value={plan.tier ? cloudPlanLabel(plan.tier) : undefined} onClick={() => sub.open(PLAN_BILLING_PAGE, title)} />;
}

/** Plan & billing: the plan and when it renews, the account page for the card and invoices, and at the very bottom a quiet
 * Cancel subscription. */
export function PlanBillingPage() {
  const plan = usePlanBilling();
  const [failed, setFailed] = useState(false);
  if (!plan) return <p data-plan-billing="none" className="px-3 text-[13px] text-ink-secondary">{t("settings.planBilling.none")}</p>;
  const open = (action: () => Promise<unknown>) => { setFailed(false); void action().catch(() => setFailed(true)); };
  const trial = plan.trial ? cloudTrialView(plan.trial) : null;
  const renews = plan.renewal && !plan.renewal.cancelled && plan.renewal.renewsAt && !plan.renewal.trial ? t("settings.planBilling.renews", { date: day(plan.renewal.renewsAt) }) : undefined;
  const offers: CloudCancelOffers = { usage: plan.usage ?? null, cheaper: cheaperThan(plan.tier), openPlans: plan.openPlans, openLink: openExternalLink };
  return <div data-plan-billing="" className="flex flex-col gap-[22px]">
    <SettingsGroup label={t("settings.simple.billing.plan")} block="plan">
      <SettingsRows>
      <ItemRow data-panel-row="plan" title={plan.line} hint={trial ? trial.title : renews} />
      {trial && <p className="px-2 pb-1.5 text-[12px] leading-4 text-ink-secondary">{trial.body}</p>}
      {plan.payment && <ItemRow data-panel-row="payment" tone="warn" title={t(plan.payment.trial ? "cloudAccount.trialNotice" : "cloudAccount.paymentNotice", { name: plan.payment.name, date: day(plan.payment.fixBy) })} />}
      </SettingsRows>
    </SettingsGroup>
    <SettingsGroup label={t("settings.planBilling.billing")} block="billing">
      <SettingsRows>
        <NavRow data-settings-open="payment-invoices" title={t("settings.planBilling.payment")} hint={t("settings.planBilling.paymentHint")} external onClick={() => open(plan.openAccount)} />
      </SettingsRows>
    </SettingsGroup>
    {failed && <p role="alert" className="px-3 text-[13px] text-danger">{t("cloudAccount.actionFailed")}</p>}
    {plan.renewal && plan.actions && <div className="px-3"><CloudCancelPlan renewal={plan.renewal} actions={plan.actions} offers={offers} onChanged={cloudPlanChanged} /></div>}
  </div>;
}
