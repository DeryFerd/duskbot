import { describe, expect, it } from "vitest";
import { groupPreview, lastLine, sidebarPreviewMessages, withNewerPreview } from "@/components/sidebar-preview";
import { initialState, reducer, visibleMessages, type Bot, type Group, type Message } from "./store";

const intro: Message = { id: "intro", role: "bot", kind: "text", text: "Hi, I'm Pepper, your helper.", at: 1 };
const reply = (threadId: string, text: string, at = 10): Message => ({ id: `${threadId}-reply`, role: "bot", kind: "text", text, at, parentId: null });

const bot = (extra: Partial<Bot> = {}): Bot => ({
  id: "pepper", threadId: "main", name: "Pepper", title: "", description: "", notifications: true, color: "green",
  unread: false, busy: false, modelSelection: { instanceId: "claude", model: "m" }, approvalMode: "ask", alwaysAllow: [],
  messages: [intro], activeLeafId: intro.id,
  tasks: [
    { threadId: "main", title: "Main", createdAt: 1, activity: "idle", busy: false, unread: false, modelSelection: { instanceId: "claude", model: "m" }, approvalMode: "ask" },
    { threadId: "task", title: "Task", createdAt: 2, activity: "idle", busy: false, unread: false, modelSelection: { instanceId: "claude", model: "m" }, approvalMode: "ask" },
  ],
  ...extra,
}) as Bot;

const rowLine = (state: ReturnType<typeof reducer>) => {
  const row = state.bots[0]!;
  const visible = row.transcriptLoaded === false ? sidebarPreviewMessages(row) : visibleMessages(row);
  return lastLine(row, withNewerPreview(visible, row.previewMessages), []);
};

describe("a sidebar row's preview follows the newest message live", () => {
  it("shows a reply that lands in the bot's main chat while only a preview is loaded", () => {
    const start = { ...initialState, bots: [bot({ transcriptLoaded: false, messages: [], previewMessages: [intro] })], selectedId: "" };
    const next = reducer(start, { type: "messageAdded", threadId: "main", message: reply("main", "Done, I filed it.") });
    expect(rowLine(next)).toBe("Done, I filed it.");
  });

  it("shows a reply that lands in another task thread of the bot", () => {
    const start = { ...initialState, bots: [bot({ previewMessages: [intro] })], selectedId: "" };
    const next = reducer(start, { type: "messageAdded", threadId: "task", message: reply("task", "Routine finished.") });
    expect(rowLine(next)).toBe("Routine finished.");
    const patched = reducer(next, { type: "messagePatched", threadId: "task", message: { ...reply("task", "Routine finished, 3 items.") } });
    expect(rowLine(patched)).toBe("Routine finished, 3 items.");
  });

  it("shows a reply in a task thread of a group chat", () => {
    const group = { id: "room", name: "Room", threadId: "room-main", messages: [intro], previewMessages: [intro], tasks: [{ threadId: "room-task", title: "T", createdAt: 2 }] } as unknown as Group;
    const start = { ...initialState, groups: [group], selectedId: "" };
    const next = reducer(start, { type: "messageAdded", threadId: "room-task", message: reply("room-task", "Plan is ready.") });
    expect(groupPreview(next.groups[0]!, [], [])).toBe("Plan is ready.");
  });
});
