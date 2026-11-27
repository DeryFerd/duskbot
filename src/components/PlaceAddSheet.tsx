// The add-a-place sheet's frame and its choice cards (the sheet itself is PlaceSetup.tsx).
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Tag } from "./cloud-buy/parts";
import "../styles/settings.css";

/** `art`: the icon is a drawn mark of its own, shown as it is rather than on a tinted tile. */
export function Choice({ icon, title, sub, onClick, kind, tag, art = false }: { icon: ReactNode; title: string; sub: string; onClick: () => void; kind: string; tag?: string; art?: boolean }) {
  return <button type="button" data-place-add-choice={kind} onClick={onClick}
    className={cn("flex min-w-0 flex-1 flex-col items-start gap-2 rounded-[14px] bg-ink/[0.035] p-5 text-start transition-colors hover:bg-ink/[0.06] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus")}>
    <span className="flex w-full items-center justify-between gap-2">
      <span aria-hidden="true" className={cn("grid place-items-center", art ? "size-11" : "size-9", !art && "rounded-[10px] bg-accent/12 text-accent-text")}>{icon}</span>
      {tag && <Tag data-place-add-tag="">{tag}</Tag>}
    </span>
    <span className="text-[15px] font-semibold text-ink">{title}</span>
    <span className="text-[13px] leading-snug text-ink-secondary">{sub}</span>
  </button>;
}

const FOCUSABLE = "button:not([disabled]):not([tabindex='-1']), input:not([disabled]):not([tabindex='-1']), [href], [tabindex='0']";

/** The sheet over the app, like the buying sheet's: Escape and Close close it, Tab stays in it, focus goes back after. */
/** `above`: over the full-screen places picker (z-[60]), which stays up behind it so closing returns there */
export function RailSheet({ wide = false, above = false, focusKey, onClose, children }: { wide?: boolean; above?: boolean; focusKey: string; onClose: () => void; children: ReactNode }) {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = [...(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!controls.length) return;
      event.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLElement);
      controls[at === -1 ? 0 : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); if (opener?.isConnected) opener.focus(); };
  }, [onClose]);
  useEffect(() => {
    if (sheet.current?.contains(document.activeElement) && document.activeElement !== sheet.current) return;
    (sheet.current?.querySelector<HTMLElement>("[data-autofocus]") ?? sheet.current?.querySelector<HTMLElement>("#cloud-add-title"))?.focus();
  }, [focusKey]);
  return <div className="settings-scrim" style={{ zIndex: above ? 61 : 60 }} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div aria-hidden="true" className="settings-backdrop pointer-events-none" />
    <div ref={sheet} role="dialog" aria-modal="true" aria-labelledby="cloud-add-title" data-place-add-sheet tabIndex={-1}
      className="settings-dialog" style={{ width: `min(${wide ? 900 : 560}px, 100vw - 32px)`, overflowY: "auto", overscrollBehavior: "contain" }}>
      <button type="button" onClick={onClose} aria-label={t("cloudAdd.close")} className="settings-close"><Icon name="close" size={14} /></button>
      {children}
    </div>
  </div>;
}
