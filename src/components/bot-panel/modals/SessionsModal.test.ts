import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import { RadioRow } from "../rows";
import { SessionsModal, sessionsValue } from "./SessionsModal";

type Row = ReactElement<{ "data-panel-choice": string; title: string; checked: boolean; onClick: () => void }>;

function rows(node: ReactNode): Row[] {
  const found: Row[] = [];
  const walk = (child: ReactNode) => Children.forEach(child, (element) => {
    if (!isValidElement(element)) return;
    if (element.type === RadioRow) found.push(element as Row);
    walk((element.props as { children?: ReactNode }).children);
  });
  walk(node);
  return found;
}

function draw(bot: Partial<Bot>) {
  const patch = vi.fn();
  const tree = SessionsModal({ bot: { id: "b1", name: "Scout", ...bot } as Bot, derived: { patch } as never });
  const all = rows(tree);
  return { patch, all, row: (choice: string) => all.find((row) => row.props["data-panel-choice"] === choice)! };
}

describe("the Sessions page", () => {
  it("offers never, every day and two idle spans, then four compaction points with the default third", () => {
    const { all } = draw({});
    expect(all.map((row) => row.props["data-panel-choice"])).toEqual([
      "fresh-never", "fresh-day", "fresh-idle-6", "fresh-idle-24",
      "compact-50", "compact-70", "compact-default", "compact-90",
    ]);
    expect(all.filter((row) => row.props.checked).map((row) => row.props["data-panel-choice"])).toEqual(["fresh-never", "compact-default"]);
    expect(all.map((row) => row.props.title)).toContain("80% (default)");
  });

  it("saves each choice as the server reads it, and the default as null", () => {
    const fresh = draw({ freshSession: { every: "day" }, compactAt: 0.5 });
    expect(fresh.row("fresh-day").props.checked).toBe(true);
    expect(fresh.row("compact-50").props.checked).toBe(true);
    fresh.row("fresh-idle-24").props.onClick();
    expect(fresh.patch).toHaveBeenLastCalledWith({ freshSession: { idleHours: 24 } });
    fresh.row("fresh-never").props.onClick();
    expect(fresh.patch).toHaveBeenLastCalledWith({ freshSession: null });
    fresh.row("compact-default").props.onClick();
    expect(fresh.patch).toHaveBeenLastCalledWith({ compactAt: null });
    fresh.row("compact-90").props.onClick();
    expect(fresh.patch).toHaveBeenLastCalledWith({ compactAt: 0.9 });
    // picking what is already chosen saves nothing
    const calls = fresh.patch.mock.calls.length;
    fresh.row("fresh-day").props.onClick();
    expect(fresh.patch.mock.calls).toHaveLength(calls);
  });

  it("names the choice on its row only when it is not the default", () => {
    expect(sessionsValue({})).toBeUndefined();
    expect(sessionsValue({ freshSession: null, compactAt: null })).toBeUndefined();
    expect(sessionsValue({ freshSession: { idleHours: 6 } })).toBe("After 6 hours idle");
    expect(sessionsValue({ compactAt: 0.7 })).toBe("70%");
  });
});
