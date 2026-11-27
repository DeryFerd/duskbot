import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { COMPACT_AT_CHOICES, FRESH_SESSION_IDLE_HOURS, type FreshSession } from "../../../../shared/session-settings";
import type { useBotSettingsDerived } from "../../bot-settings/useBotSettingsDerived";
import { Card, SheetPane } from "../../ListRows";
import { radioArrows, RadioRow } from "../rows";

type FreshChoice = "never" | "day" | `idle-${(typeof FRESH_SESSION_IDLE_HOURS)[number]}`;
const FRESH_CHOICES: FreshChoice[] = ["never", "day", ...FRESH_SESSION_IDLE_HOURS.map((hours) => `idle-${hours}` as const)];

function freshChoice(policy: FreshSession | null | undefined): FreshChoice | null {
  if (!policy) return "never";
  if ("every" in policy) return "day";
  return FRESH_CHOICES.find((choice) => choice === `idle-${policy.idleHours}`) ?? null;
}

function freshPolicy(choice: FreshChoice): FreshSession | null {
  if (choice === "never") return null;
  if (choice === "day") return { every: "day" };
  return { idleHours: Number(choice.slice("idle-".length)) };
}

function freshLabel(choice: FreshChoice): string {
  if (choice === "never") return t("botPanel.sessions.never");
  if (choice === "day") return t("botPanel.sessions.daily");
  return t("botPanel.sessions.idle", { hours: Number(choice.slice("idle-".length)) });
}

const percent = (fraction: number) => Math.round(fraction * 100);

/** What the Sessions row says beside its name: the fresh session choice, else a compaction point that is not the default. */
export function sessionsValue(bot: Pick<Bot, "freshSession" | "compactAt">): string | undefined {
  const choice = freshChoice(bot.freshSession);
  if (choice && choice !== "never") return freshLabel(choice);
  if (typeof bot.compactAt === "number") return t("botPanel.sessions.compactValue", { percent: percent(bot.compactAt) });
  return undefined;
}

/** When the bot's chats start a fresh session by themselves, and how full its context gets before it is compacted. */
export function SessionsModal({ bot, derived }: { bot: Bot; derived: ReturnType<typeof useBotSettingsDerived> }) {
  const editable = bot.yourAccess !== "view";
  const fresh = freshChoice(bot.freshSession);
  const compactAt = typeof bot.compactAt === "number" ? bot.compactAt : null;
  const compactChoices: Array<number | null> = [...COMPACT_AT_CHOICES.slice(0, 2), null, ...COMPACT_AT_CHOICES.slice(2)];
  return (
    <SheetPane data-panel-modal="sessions" title={t("botPanel.sessions.title")}>
      <Card label={t("botPanel.sessions.fresh")} anchor="fresh-session" data-sheet-group="fresh-session" footnote={t("botPanel.sessions.freshHint")}>
        <div role="radiogroup" aria-label={t("botPanel.sessions.fresh")} onKeyDown={radioArrows} className="contents">
          {FRESH_CHOICES.map((choice) => (
            <RadioRow
              key={choice}
              data-panel-choice={`fresh-${choice}`}
              title={freshLabel(choice)}
              hint={choice === "day" ? t("botPanel.sessions.dailyHint") : undefined}
              checked={fresh === choice}
              tabIndex={fresh === choice || (fresh === null && choice === "never") ? 0 : -1}
              disabled={!editable}
              onClick={() => { if (fresh !== choice) derived.patch({ freshSession: freshPolicy(choice) }); }}
            />
          ))}
        </div>
      </Card>
      <Card label={t("botPanel.sessions.compactAt")} anchor="compact-at" data-sheet-group="compact-at" footnote={t("botPanel.sessions.compactHint")}>
        <div role="radiogroup" aria-label={t("botPanel.sessions.compactAt")} onKeyDown={radioArrows} className="contents">
          {compactChoices.map((choice) => (
            <RadioRow
              key={choice ?? "default"}
              data-panel-choice={`compact-${choice === null ? "default" : percent(choice)}`}
              title={choice === null ? t("botPanel.sessions.compactDefault") : t("botPanel.sessions.compactValue", { percent: percent(choice) })}
              checked={compactAt === choice}
              tabIndex={compactAt === choice ? 0 : -1}
              disabled={!editable}
              onClick={() => { if (compactAt !== choice) derived.patch({ compactAt: choice }); }}
            />
          ))}
        </div>
      </Card>
    </SheetPane>
  );
}
