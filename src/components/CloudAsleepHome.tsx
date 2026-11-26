import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "../icons";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { randomUuid } from "@/lib/random-uuid";
import type { HomeBridge, HomeView, LastSeen } from "../../electron/home-window.mjs";
import { SIMPLE_COMPOSER } from "./composer-simple";
import { MAC_TRAFFIC_LIGHT_CLEAR_X, useCaptionChrome, useDesktopCapabilities, WindowDragStrip } from "./DesktopCapabilities";
import { MascotLoader } from "./MascotLoader";

type AsleepView = Extract<HomeView, { screen: "asleep" }>;
type WakeIntent = "type" | "click" | "send";

/** Keys that are only moving around or switching windows: never someone starting to type. */
const NOT_TYPING = new Set(["Tab", "Shift", "Control", "Alt", "Meta", "CapsLock", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

/**
 * My Cloud coming back, on this computer's screen: its chats as this computer last saw them, read-only, and a composer.
 * Opening it wakes it (main's `home:wake`) and the line only says it is connecting; a message sent meanwhile is held and
 * sent by My Cloud's page once it opens.
 */
export function CloudAsleepHome({ bridge, view }: { bridge: Pick<HomeBridge, "wake" | "lastSeen">; view: AsleepView }) {
  const [seen, setSeen] = useState<LastSeen | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const [, setAsked] = useState(false);
  const askedRef = useRef(false);
  const end = useRef<HTMLLIElement | null>(null);
  const { dragProps } = useCaptionChrome();
  const macInset = useDesktopCapabilities().capabilities.windowChrome === "mac-inset";

  useEffect(() => {
    let alive = true;
    void (bridge.lastSeen?.() ?? Promise.resolve(null)).then((next) => { if (alive) setSeen(next); }, () => { if (alive) setSeen(null); });
    return () => { alive = false; };
  }, [bridge]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { wake("click"); }, []);

  // waking says so with how long it usually takes, and past a minute that it's slower than usual: never "can't reach"
  const line = t(view.slow ? "cloudAsleep.wakingSlow" : "cloudAsleep.wakingUp");
  const bots = seen?.bots ?? [];
  const bot = bots.find((entry) => entry.id === selected) ?? bots[0] ?? null;
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [bot?.id, view.held]);

  const wake = (intent: WakeIntent, send?: { botId: string; threadId: string; text: string; sendId: string }) => {
    if (!bridge.wake) return;
    if (intent !== "send" && (askedRef.current || view.waking)) return;
    askedRef.current = true;
    setAsked(true);
    setFailed(false);
    void bridge.wake(intent, send ?? null).catch(() => { askedRef.current = false; setAsked(false); setFailed(true); });
  };
  const send = () => {
    const text = draft.trim();
    if (!text || !bot) return;
    wake("send", { botId: bot.id, threadId: bot.threadId, text, sendId: randomUuid() });
    setDraft("");
  };

  // nothing seen here yet: the loading mascot while it connects, never an empty chat list
  if (!bot) {
    return (
      <main data-home-screen="asleep" data-cloud-asleep-loading className="relative flex min-h-[100dvh] flex-col items-center justify-center gap-3 bg-app px-6 text-ink">
        <WindowDragStrip />
        {failed
          ? <>
            <p role="alert" className="max-w-[360px] text-center text-[14px] leading-relaxed text-danger">{t("cloudAccount.actionFailed")}</p>
            <button type="button" className="ui-button ui-button-primary" onClick={() => wake("click")}>{t("cloudHome.tryAgain")}</button>
          </>
          : <MascotLoader size={64} first={line} lineClassName="text-[14px] leading-5 text-ink" />}
      </main>
    );
  }

  return (
    <main data-home-screen="asleep" className="flex min-h-[100dvh] flex-col bg-app text-ink">
      <header {...dragProps} data-cloud-asleep-bar className="flex h-[52px] shrink-0 items-center px-5"
        style={{ ...dragProps.style, ...(macInset ? { paddingLeft: MAC_TRAFFIC_LIGHT_CLEAR_X } : {}) }}>
        <p role="status" data-cloud-asleep-line className="flex min-w-0 items-center gap-2 text-[13px] text-ink-secondary">
          <span aria-hidden="true" className="size-3 shrink-0 animate-spin rounded-full border-2 border-transparent border-t-accent motion-reduce:animate-none" />
          <span className="truncate">{line}</span>
        </p>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {bots.length > 1 && (
          <nav aria-label={t("cloudAsleep.bots")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-transparent px-2 py-2 sm:w-[220px] sm:flex-col sm:overflow-y-auto sm:border-r sm:border-b-0 sm:py-3">
            {bots.map((entry) => (
              <button key={entry.id} type="button" aria-current={entry.id === bot?.id ? "page" : undefined} onClick={() => setSelected(entry.id)}
                className={cn("min-h-9 shrink-0 truncate rounded-lg px-3 py-1.5 text-left text-[14px] text-ink-secondary hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent",
                  entry.id === bot?.id && "bg-ink/[0.06] font-medium text-ink")}>
                {entry.name}
              </button>
            ))}
          </nav>
        )}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ol aria-label={bot.name} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 py-3">
            {bot.messages.map((message) => (
              <li key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cn("w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed text-ink", message.role === "user" ? "bg-bubble-user" : "bg-card")}>
                  {message.text}
                </div>
              </li>
            ))}
            {view.held && (
              <li data-cloud-asleep-held className="flex flex-col items-end gap-1">
                <div className="w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-bubble-user px-3.5 py-2 text-[14px] leading-relaxed text-ink opacity-70">{view.held}</div>
                <span className="text-[12px] text-ink-secondary">{t("cloudAsleep.held")}</span>
              </li>
            )}
            <li ref={end} aria-hidden="true" />
          </ol>
          <div className="px-4 pb-4">
            {failed && <p role="alert" className="px-2 pb-2 text-[13px] text-danger">{t("cloudAccount.actionFailed")}</p>}
            <form className={cn(SIMPLE_COMPOSER, "flex-row items-end gap-2 rounded-[22px]")} onSubmit={(event) => { event.preventDefault(); send(); }}>
              <textarea value={draft} rows={1} data-cloud-asleep-composer
                aria-label={t("composer.placeholder.bot", { name: bot.name })} placeholder={t("composer.placeholder.bot", { name: bot.name })}
                className="max-h-40 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-normal text-ink outline-none placeholder:text-ink-secondary"
                onChange={(event) => setDraft(event.target.value)}
                onPointerDown={() => wake("click")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); return; }
                  if (!NOT_TYPING.has(event.key) && !event.metaKey && !event.ctrlKey) wake("type");
                }} />
              <button type="submit" aria-label={t("chat.send")} disabled={!draft.trim()}
                className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-app hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-30">
                <ArrowUp size={16} aria-hidden="true" />
              </button>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
