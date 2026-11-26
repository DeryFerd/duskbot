import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** grok's transcript system event: a centered 12/16 line of quiet labels and chips. */
export function EventLine({ children, className, role, ...rest }: { children: ReactNode; className?: string; role?: "status" } & Record<`data-${string}`, string | undefined>) {
  return (
    <div
      role={role}
      {...rest}
      data-event-line=""
      className={cn("flex min-h-6 w-full min-w-0 items-center justify-center gap-0.5 text-[12px] leading-4 tracking-[0.01em] text-ink-secondary", className)}
    >
      {children}
    </div>
  );
}

export function EventLabel({ children, tone = "secondary" }: { children: ReactNode; tone?: "secondary" | "tertiary" }) {
  return <span className={cn("shrink-0 whitespace-nowrap", tone === "tertiary" ? "text-ink-tertiary" : "text-ink-secondary")}>{children}</span>;
}

const CHIP = "inline-flex min-w-0 shrink items-center rounded-full py-1 pr-1.5 pl-1 tracking-[0.015em] text-ink-secondary";
const CHIP_INTERACTIVE =
  "cursor-pointer transition-[background-color,color] duration-[120ms] ease-out hover:bg-menu-hover hover:text-ink active:bg-menu-active focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-focus motion-reduce:transition-none";

type ChipProps = { leading?: ReactNode; wideGap?: boolean; children: ReactNode; title?: string };

/** A named thing inside an event line: its avatar or icon, then its name. A button only when it does something. */
export function EventChip({ leading, wideGap = false, children, title, onClick, ...button }: ChipProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title">) {
  const body = (
    <>
      {leading && <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">{leading}</span>}
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
  const gap = wideGap ? "gap-1" : "gap-0.5";
  if (!onClick) return <span title={title} className={cn(CHIP, gap)}>{body}</span>;
  return (
    <button type="button" title={title} onClick={onClick} {...button} className={cn(CHIP, gap, CHIP_INTERACTIVE, button.className)}>
      {body}
    </button>
  );
}
