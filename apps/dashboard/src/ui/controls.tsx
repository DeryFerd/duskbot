import { useEffect, useId, useRef, type ReactNode, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "@/icons";
import { cx } from "./kit";
import { AnimatePresence, EASE_OUT, GLIDE, m, Pill, SPRING, usePill } from "./motion";
import { StretchPill } from "./Digits";

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("switch-track relative inline-flex h-[26px] w-[44px] shrink-0 items-center rounded-full p-[3px] disabled:opacity-45", checked ? "bg-accent" : "bg-track")}
    >
      <m.span className="size-5 rounded-full bg-white" initial={false} animate={{ x: checked ? 18 : 0 }} transition={SPRING} aria-hidden />
    </button>
  );
}

/** a labelled range with its value on the right; no motion while dragging, it is hit dozens of times a second */
export function Slider({ label, value, min, max, step, onChange, format, hint }: { label: string; value: number; min: number; max: number; step: number; onChange(v: number): void; format(v: number): string; hint?: ReactNode }) {
  const id = useId();
  const fill = ((value - min) / Math.max(1, max - min)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-14 text-ink-2">{label}</label>
        <span className="num text-14 font-medium text-ink">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        className="range mt-1.5"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ["--fill" as string]: `${fill}%` }}
      />
      <div className="flex justify-between text-12 text-ink-4" aria-hidden><span>{format(min)}</span>{hint && <span className="text-ink-3">{hint}</span>}<span>{format(max)}</span></div>
    </div>
  );
}

/** a two to four way choice with a thumb that slides between options; transitions retarget on rapid clicks */
/** `stretch`: the highlight stretches to the picked option instead of sliding (the billing period) */
export function Toggle<T extends string>({ value, options, onChange, label, className, stretch = false }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange(v: T): void; label: string; className?: string; stretch?: boolean }) {
  const pill = usePill();
  return (
    <div role="radiogroup" aria-label={label} className={cx("relative inline-grid shrink-0 rounded-full bg-card-2 p-1", className)} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {stretch && <StretchPill target={value} />}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-stretch-key={o.value}
          onClick={() => onChange(o.value)}
          className={cx("relative inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-13 font-medium", value === o.value ? "text-ink" : "text-ink-3 hover-link")}
        >
          {!stretch && value === o.value && <Pill id={pill} />}
          <span className="relative inline-flex items-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string | null; hint?: ReactNode; children: ReactNode; htmlFor: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-13 text-ink-2">{label}</label>
      {children}
      {error ? <p id={`${htmlFor}-error`} role="alert" className="mt-2 text-13 text-bad">{error}</p> : hint ? <p className="mt-2 text-13 text-ink-3">{hint}</p> : null}
    </div>
  );
}

/** escape closes, tab stays inside, the body stops scrolling, focus moves in and comes back */
function useDialog(open: boolean, onClose: () => void, ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close])");
    (first ?? ref.current)?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, textarea, a[href]")];
      if (!items.length) return;
      const [a, z] = [items[0]!, items[items.length - 1]!];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = overflow; back?.focus(); };
  }, [open, onClose, ref]);
}

const scrim = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.2, ease: EASE_OUT } } as const;

/** a centered dialog: scrim, escape and outside click close it, focus moves in and comes back; it scales in from the
 * middle and fades out, and also plays its exit when an AnimatePresence above it drops it */
/** `top`: art that bleeds to the dialog's top edge, over the title; the close button floats on it */
export function Modal({ open, onClose, title, children, footer, wide, top }: { open: boolean; onClose(): void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean | "xl"; top?: ReactNode }) {
  // a portal, so a dialog opened from a table row or an animated card is never trapped under the shell
  return createPortal(<AnimatePresence propagate>{open && <ModalFrame key="modal" onClose={onClose} title={title} footer={footer} wide={wide} top={top}>{children}</ModalFrame>}</AnimatePresence>, document.body);
}
function ModalFrame({ onClose, title, children, footer, wide, top }: { onClose(): void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean | "xl"; top?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(true, onClose, ref);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
      <m.div {...scrim} className="absolute inset-0" style={{ background: "var(--scrim)" }} onClick={onClose} aria-hidden />
      <m.div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={cx("pop relative my-auto w-full min-w-0 rounded-[28px] bg-pop p-7 outline-none max-sm:p-5", wide === "xl" ? "max-w-[760px]" : wide ? "max-w-[540px]" : "max-w-[440px]")} style={{ boxShadow: "var(--pop-shadow)" }}
        initial={{ opacity: 0, scale: 0.96, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.16, ease: EASE_OUT } }} transition={GLIDE}>
        {top && <div className="-mx-7 -mt-7 mb-4 overflow-hidden rounded-t-[28px] max-sm:-mx-5 max-sm:-mt-5">{top}</div>}
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-20 font-medium tracking-[-0.03em] text-ink">{title}</h2>
          <button data-close type="button" onClick={onClose} aria-label="close" className={cx("press grid size-10 shrink-0 place-items-center rounded-full", top ? "absolute end-3 top-3 bg-pop/85 text-ink-2 hover:bg-pop" : "hover-ghost -me-2 -mt-2 text-ink-3")}><X size={18} strokeWidth={1.5} /></button>
        </div>
        <div className="mt-2 text-14 leading-[1.55] text-ink-3">{children}</div>
        {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
      </m.div>
    </div>
  );
}

/** a status line with a dot; the colour always comes with words */
export function StatusDot({ tone, live, children, className }: { tone: "good" | "warn" | "bad" | "quiet" | "accent"; live?: boolean; children: ReactNode; className?: string }) {
  const color = { good: "text-good", warn: "text-warn", bad: "text-bad", quiet: "text-ink-4", accent: "text-accent" }[tone];
  return (
    <span className={cx("inline-flex items-center gap-2 text-13 text-ink-3", className)}>
      <span className={cx("live-dot", color)} data-live={live} aria-hidden />
      <span className="num">{children}</span>
    </span>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx("relative block", className)}>
      <select {...rest} className="field cursor-pointer appearance-none pe-10">{children}</select>
      <ChevronDown size={16} strokeWidth={1.5} className="pointer-events-none absolute end-3.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
    </span>
  );
}

/** a side sheet from the right edge: the same dialog rules as Modal, with a footer that stays put; it glides in and back out */
export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose(): void; title: string; children: ReactNode; footer?: ReactNode }) {
  return createPortal(<AnimatePresence propagate>{open && <SheetFrame key="sheet" onClose={onClose} title={title} footer={footer}>{children}</SheetFrame>}</AnimatePresence>, document.body);
}
function SheetFrame({ onClose, title, children, footer }: { onClose(): void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(true, onClose, ref);
  return (
    <div className="fixed inset-0 z-50">
      <m.div {...scrim} className="absolute inset-0" style={{ background: "var(--scrim)" }} onClick={onClose} aria-hidden />
      <m.div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="pop absolute inset-y-0 right-0 flex w-[min(460px,100vw)] flex-col bg-pop outline-none sm:inset-y-3 sm:right-3 sm:rounded-[28px]" style={{ boxShadow: "var(--pop-shadow)" }}
        initial={{ x: "104%", opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: "104%", opacity: 0, transition: { type: "spring", visualDuration: 0.24, bounce: 0 } }} transition={GLIDE}>
        <div className="flex items-center justify-between gap-4 px-6 pb-2 pt-5 max-sm:px-5 max-sm:pt-[max(20px,env(safe-area-inset-top))]">
          <h2 id={titleId} className="text-20 font-medium tracking-[-0.03em] text-ink">{title}</h2>
          <button data-close type="button" onClick={onClose} aria-label="close" className="hover-ghost -me-2 grid size-10 shrink-0 place-items-center rounded-full text-ink-3 max-sm:size-11"><X size={18} strokeWidth={1.5} /></button>
        </div>
        <div className={cx("min-h-0 flex-1 overflow-y-auto px-6 pb-6 max-sm:px-5", !footer && "max-sm:pb-[max(24px,env(safe-area-inset-bottom))]")}>{children}</div>
        {footer && <div className="px-6 pb-[max(20px,env(safe-area-inset-bottom))] pt-4 max-sm:px-5">{footer}</div>}
      </m.div>
    </div>
  );
}

/** a radio row: a dot, a name with one line under it, and a value on the right */
export function Choice({ name, value, checked, onChange, title, detail, aside }: { name: string; value: string; checked: boolean; onChange(): void; title: ReactNode; detail?: ReactNode; aside?: ReactNode }) {
  const id = `${name}-${value}`;
  return (
    <label htmlFor={id} className={cx("pick focus-tint flex min-h-14 cursor-pointer items-center gap-3 rounded-[16px] px-3.5 py-2.5", checked ? "bg-btn" : "hover-row")}>
      <input id={id} type="radio" name={name} value={value} checked={checked} onChange={onChange} className="peer sr-only" />
      <span aria-hidden className={cx("grid size-4 shrink-0 place-items-center rounded-full", checked ? "bg-ink" : "bg-track")}>{checked && <span className="size-1.5 rounded-full bg-bg" />}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-14 text-ink">{title}</span>
        {detail && <span className="block text-13 text-ink-3">{detail}</span>}
      </span>
      {aside && <span className="num shrink-0 text-end text-14 text-ink-2">{aside}</span>}
    </label>
  );
}
