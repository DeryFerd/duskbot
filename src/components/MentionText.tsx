import { Fragment, type CSSProperties, type ReactNode } from "react";
import { mentionClassName, mentionRanges, type MentionPeer, type MentionPerson } from "@/lib/mentions";
import { linkRanges } from "@/lib/link-ranges";

/**
 * `links` marks web addresses as link pills: "highlight" paints them only (the composer's mirror, which sits under the
 * real field and must never change the text's layout), "open" makes each one a link that opens outside the app.
 * `hoverStart` is where the address under the pointer starts, so the composer can show its box.
 */
export function MentionText({ text, peers, everyone = false, person, links, hoverStart, command }: {
  text: string; peers: readonly MentionPeer[]; everyone?: boolean; person?: MentionPerson; links?: "highlight" | "open";
  hoverStart?: number | null;
  /** The composer's slash command at the start of the text: painted in `color`, the text itself unchanged. */
  command?: { end: number; color: string };
}) {
  const addresses = links ? linkRanges(text) : [];
  // a name inside an address is part of the address, not a mention
  const mentions = mentionRanges(text, peers, everyone, person)
    .filter((range) => !addresses.some((link) => range.start < link.end && link.start < range.end));
  const ranges = [
    ...(command ? [{ start: 0, end: command.end, command: command.color }] : []),
    ...addresses.map((link) => ({ ...link, link: true as const })), ...mentions,
  ].sort((a, b) => a.start - b.start);
  let end = 0;
  const parts = ranges.map((range) => {
    const prefix = text.slice(end, range.start);
    end = range.end;
    const value = text.slice(range.start, range.end);
    let node: ReactNode;
    if ("command" in range) {
      node = <span className="slash-command" style={{ color: range.command }}>{value}</span>;
    } else if ("link" in range) {
      node = links === "open"
        ? <a href={range.href} target="_blank" rel="noreferrer" dir="ltr" className="link-pill">{value}</a>
        : <span className="link-pill" data-link-start={range.start} data-link-end={range.end} data-href={range.href}
          data-hover={hoverStart === range.start ? "" : undefined}>{value}</span>;
    } else {
      const style = range.color ? { "--mention-color": range.color } as CSSProperties : undefined;
      node = <span className={mentionClassName(range)} style={style}>{value}</span>;
    }
    return <Fragment key={range.start}>{prefix}{node}</Fragment>;
  });
  return <>{parts}{text.slice(end)}</>;
}
