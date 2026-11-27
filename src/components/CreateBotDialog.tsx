import { ModalLayer } from "./ui/ModalLayer";
import { ScrimMotion, SheetMotion, useDialogMotion } from "./ui/SheetMotion";
import { AnimatePresence } from "motion/react";
import { useEffect, useId, useRef, useState, type FocusEvent as ReactFocusEvent, type PointerEvent as ReactPointerEvent } from "react";
import { DUSK_BODY_IDS, type DuskBodyId } from "../../shared/body-migration";
import { takeImportName } from "../../shared/import-name";
import { MAUS_COLOR_LABEL, PICKER_COLORS, colorSwatch, rowsOfFive, type MausColor } from "@/lib/mascot";
import { useStore } from "@/state/store";
import { prefetchBotDefaults } from "@/lib/bot-defaults-prefetch";
import { stoppedAtBotLimit } from "@/lib/bot-limit";
import { CREATE_BOT_EVENT, openCreateBot, takeCreateBotSection } from "@/lib/create-bot-request";
import { openNewGroup } from "@/lib/new-group-request";
import { t } from "@/lib/i18n";
import { upperFirst } from "@/lib/lower-first";
import { cn } from "@/lib/cn";
import { MausAvatar, type MausAvatarHandle } from "./Avatar";
import { focusComposerWhenShown } from "./AskCard";
import { Icon } from "./Icon";
import { hoverGaze } from "./mascot-engine";
import { BodyRing } from "./mascot-view";
import { SIMPLE_BUTTONS, SIMPLE_CARD, SettingsGroup } from "./SettingsPrimitives";
import { compactBackdropStyle, compactSheetStyle } from "./compact-settings-sheet";
import "../styles/settings.css";

/** Our bodies, in two rows of five. */
const SHAPES: DuskBodyId[][] = rowsOfFive(DUSK_BODY_IDS);


export { openCreateBot };

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

function useOpenRequests(onOpen: () => void) {
  const latest = useRef(onOpen);
  latest.current = onOpen;
  useEffect(() => {
    const open = () => latest.current();
    window.addEventListener(CREATE_BOT_EVENT, open);
    return () => window.removeEventListener(CREATE_BOT_EVENT, open);
  }, []);
}

export function CreateBotDialog() {
  const [session, setSession] = useState<{ key: number; section?: string } | null>(null);
  useOpenRequests(() => { const section = takeCreateBotSection(); setSession((open) => open ?? { key: Date.now(), section }); });
  return <AnimatePresence>{session && <CreateBotForm key={session.key} section={session.section} onClose={() => setSession(null)} />}</AnimatePresence>;
}

function CreateBotForm({ section, onClose }: { section?: string; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const sameName = state.bots.find((bot) => bot.name.trim().toLowerCase() === name.trim().toLowerCase() && name.trim())?.name;
  // the dialog opens on a shape and colour of its own choosing, a new one each time
  const [body, setBody] = useState<DuskBodyId>(() => pick(DUSK_BODY_IDS));
  const [color, setColor] = useState<MausColor>(() => pick(PICKER_COLORS));
  const dialog = useRef<HTMLDivElement>(null);
  const played = useDialogMotion();
  const mascot = useRef<MausAvatarHandle>(null);
  const preview = useRef<HTMLSpanElement>(null);
  // the preview watches whichever shape or colour the pointer or focus is on
  const [look, setLook] = useState<{ x: number; y: number }>(FACING);
  const titleId = useId();
  const pending = state.botCreationPending === true;
  // the dialog stays until the bot exists, and keeps the draft when it could not be made
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  // the defaults the bot is made from are read while the name is typed, so Create goes straight to making it
  useEffect(() => { if (!window.duskDesktop?.remoteClient?.active) prefetchBotDefaults(); }, []);
  const canCreate = name.trim().length > 0 && !pending && !creating;
  useEffect(() => {
    if (pending) started.current = true;
    // settled with neither answer: a plan's bot limit refused it and its popup took over
    else if (creating && started.current) onClose();
  }, [pending, creating, onClose]);

  const lookAt = (target: HTMLElement) => {
    const mark = preview.current?.getBoundingClientRect();
    if (!mark) return;
    const tile = target.getBoundingClientRect();
    setLook(hoverGaze(mark, tile.left + tile.width / 2, tile.top + tile.height / 2));
  };
  const watch = {
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => lookAt(event.currentTarget),
    onFocus: (event: ReactFocusEvent<HTMLElement>) => { if (event.currentTarget.matches(":focus-visible")) lookAt(event.currentTarget); },
  };
  const rest = () => setLook(FACING);
  const pickBody = (id: DuskBodyId) => { if (id !== body) { setBody(id); mascot.current?.react?.("hop"); } };
  const pickColor = (next: MausColor) => { if (next !== color) { setColor(next); mascot.current?.react?.("wiggle"); } };
  const rename = (next: string) => {
    if (!name.trim() && next.trim()) mascot.current?.react?.("greet");
    setName(next);
  };

  const create = () => {
    if (!canCreate) return;
    if (stoppedAtBotLimit(state)) { onClose(); return; }
    started.current = false;
    setError(null);
    setCreating(true);
    dispatch({ type: "newBot", section, look: { name: name.trim(), color, mascotBody: body },
      // the new chat's box takes the keyboard from this closing dialog, however long the bot took to make
      onCreated: () => { if (dialog.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); onClose(); focusComposerWhenShown(); }, onError: (message) => { setCreating(false); setError(message); } });
  };

  const busy = useRef(false);
  busy.current = creating;
  const leave = () => { if (!busy.current) onClose(); };
  // focus goes back to what had it when the dialog opened; taken once, as the key effect below re-runs on each render
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener?.isConnected && !dialog.current?.contains(opener)) opener.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = dialog.current;
      if (!root) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); leave(); return; }
      if (event.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      // The page behind is out of reach while the dialog is up.
      if (!root.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <ModalLayer><div {...played.layer} data-settings-sheet data-settings-look="simple" className="settings-scrim">
      <ScrimMotion {...played.scrim} aria-hidden className="settings-backdrop" style={compactBackdropStyle} onMouseDown={leave} />
      <SheetMotion
        {...played.sheet}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-create-bot-dialog
        className="settings-dialog"
        style={compactSheetStyle(440)}
      >
        <section className="settings-panel min-h-0">
          <button type="button" aria-label={t("common.close")} disabled={creating} onClick={leave} className="settings-close disabled:cursor-default disabled:opacity-50">
            <Icon name="close" size={14} />
          </button>
          <div className="settings-pane-header">
            <h2 id={titleId} className="settings-pane-title">{t("createBot.title")}</h2>
          </div>
          <div className="settings-scroll">
            <div className={cn("settings-pane", SIMPLE_BUTTONS)} style={{ gap: 20, paddingBottom: 12 }}>
              <span ref={preview} className="flex self-center" data-create-bot-preview>
                <MausAvatar ref={mascot} bodyId={body} color={color} size={96} gaze={look} />
              </span>
              <div className={SIMPLE_CARD}>
                <input
                  autoFocus
                  type="text"
                  aria-label={t("botPanel.nameField")}
                  placeholder={t("createBot.namePlaceholder")}
                  value={name}
                  maxLength={80}
                  onChange={(event) => rename(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); create(); } }}
                  className="h-[34px] w-full rounded-lg border border-transparent bg-transparent px-2 text-[13px] leading-[18px] tracking-[0.015em] text-ink outline-none placeholder:text-ink-secondary focus:border-transparent!"
                />
              </div>
              {sameName && <p role="status" data-create-bot-same-name className="-mt-3 mb-0 px-3 text-[12px] leading-4 text-ink-secondary">{t("createBot.sameName", { name: sameName, next: takeImportName(name, new Set(state.bots.map((bot) => bot.name.toLowerCase())), 80) })}</p>}
              <SettingsGroup label={t("botPanel.avatar.shapes")}>
                <div className={SIMPLE_CARD}>
                  <div role="group" aria-label={t("botPanel.avatar.shapes")} className="flex flex-col gap-1 py-1.5" onPointerLeave={rest} onBlur={rest}>
                    {SHAPES.map((row) => (
                      <div key={row[0]} className="flex justify-center gap-x-[clamp(0px,calc((100%-240px)/4),8px)]">
                        {row.map((id) => (
                          <ShapeTile key={id} id={id} color={color} selected={id === body} onPick={() => pickBody(id)} {...watch} />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </SettingsGroup>
              <SettingsGroup label={t("botPanel.avatar.colors")}>
                <div className={SIMPLE_CARD}>
                  <div role="group" aria-label={t("botPanel.avatar.colors")} className="flex max-w-[232px] flex-wrap items-center justify-center gap-2 self-center py-2" onPointerLeave={rest} onBlur={rest}>
                    {PICKER_COLORS.map((swatch) => (
                      <button
                        key={swatch}
                        type="button"
                        aria-label={t("botPanel.avatar.colorNamed", { color: t(MAUS_COLOR_LABEL[swatch]) })}
                        aria-pressed={swatch === color}
                        onClick={() => pickColor(swatch)}
                        {...watch}
                        className="flex size-8 cursor-pointer items-center justify-center rounded-[50%] border border-transparent p-0 text-black outline-none hover:border-transparent focus-visible:shadow-[0_0_0_2px_var(--color-focus)] focus-visible:outline-none!"
                      >
                        <span
                          className="block size-6 rounded-[50%]"
                          style={{ background: colorSwatch(swatch), boxShadow: swatch === color ? "0 0 0 3px var(--color-composer), 0 0 0 4px color-mix(in srgb, var(--color-ink) 24%, transparent)" : undefined }}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              </SettingsGroup>
            </div>
          </div>
          {error && <p role="alert" data-create-bot-error="" className="m-0 shrink-0 px-6 pb-2 text-[13px] leading-[18px] text-danger">{error}</p>}
          <div className={cn("flex shrink-0 items-center justify-end gap-2 px-6 pb-5 pt-1", SIMPLE_BUTTONS)}>
            <button
              type="button"
              data-group-instead=""
              onClick={() => { onClose(); openNewGroup(); }}
              className="mr-auto cursor-pointer rounded-[6px] border-0 bg-transparent p-0 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary transition-colors duration-[120ms] ease-[ease-out] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {t("createBot.groupInstead")}
            </button>
            <button type="button" disabled={creating} onClick={leave} className="ui-button"><span>{t("common.cancel")}</span></button>
            <button type="button" disabled={!canCreate} aria-busy={creating} onClick={create} className="ui-button ui-button-primary">
              <span>{creating ? t("createBot.creating") : t("createBot.create")}</span>
            </button>
          </div>
        </section>
      </SheetMotion>
    </div></ModalLayer>
  );
}

const MARK = 36;

/** The preview faces the viewer at rest, turning only toward the shape or colour the pointer or focus is on. */
const FACING = { x: 0, y: 0 } as const;

/** A shape to pick, in the chosen colour. Hovered, focused or chosen, a 1px ring follows its outline 3px out: faint on
 * hover, darker once chosen. */
function ShapeTile({ id, color, selected, onPick, onPointerEnter, onFocus }: {
  id: DuskBodyId; color: MausColor; selected: boolean; onPick: () => void;
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void; onFocus: (event: ReactFocusEvent<HTMLElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-label={t("botPanel.avatar.shapeNamed", { name: upperFirst(id) })}
      aria-pressed={selected}
      onClick={onPick}
      onPointerEnter={onPointerEnter}
      onFocus={onFocus}
      className="group/shape relative inline-flex size-12 cursor-pointer appearance-none items-center justify-center border-0 bg-transparent p-0 text-black outline-none focus-visible:outline-none!"
    >
      <MausAvatar bodyId={id} color={color} size={MARK} animated={false} trackPointer={false} />
      <BodyRing
        body={id}
        size={MARK}
        className={cn(
          "pointer-events-none absolute text-ink opacity-0",
          selected ? "opacity-24" : "group-hover/shape:opacity-12 group-focus-visible/shape:opacity-24",
        )}
      />
    </button>
  );
}
