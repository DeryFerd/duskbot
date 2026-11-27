import { describe, expect, it } from "vitest";

import { mainThread } from "./main-thread.ts";
import { archiveEmptySideConversations, markSideConversation } from "./side-conversations.ts";

type Task = { threadId: string; createdAt: number; askedAt?: number; archivedAt?: number; side?: true; pinned?: true; openedBy?: unknown; routineRunId?: string };

function fakeStore(initial: Task[], said: Record<string, boolean> = {}) {
  const tasks = initial.map((task) => ({ ...task }));
  return {
    tasks: tasks as never,
    list: tasks,
    patchTask: (_bot: string, threadId: string, patch: Partial<Task>) => {
      Object.assign(tasks.find((task) => task.threadId === threadId)!, patch);
      return null;
    },
    activePath: (threadId: string) => (said[threadId] ? [{ role: "user" }] : [{ role: "bot", kind: "activity" }]) as never,
  };
}
const asStore = (store: ReturnType<typeof fakeStore>) => ({ tasks: () => store.list, patchTask: store.patchTask, activePath: store.activePath }) as never;

describe("a bot with side conversations", () => {
  it("keeps the main chat main after the person writes in a /new chat", () => {
    const main = { threadId: "main", createdAt: 1, askedAt: 10 };
    const side = { threadId: "side", createdAt: 2, askedAt: 20, side: true as const };
    expect(mainThread([main, side], "side")).toBe("main");
  });

  it("makes a side conversation main only by the person's choice", () => {
    const main = { threadId: "main", createdAt: 1, askedAt: 10 };
    const side = { threadId: "side", createdAt: 2, askedAt: 20, side: true as const };
    expect(mainThread([main, side], "side", "side")).toBe("side");
    expect(mainThread([{ ...main, archivedAt: 5 }, side], "side")).toBe("side");
  });

  it("marks a new conversation as a side one only when another open conversation of the person exists", () => {
    const alone = fakeStore([{ threadId: "new", createdAt: 1 }]);
    expect(markSideConversation(asStore(alone), "b", "new")).toBe(false);
    expect(alone.list[0]!.side).toBeUndefined();
    const beside = fakeStore([{ threadId: "main", createdAt: 1 }, { threadId: "new", createdAt: 2 }]);
    expect(markSideConversation(asStore(beside), "b", "new")).toBe(true);
    expect(beside.list[1]!.side).toBe(true);
    const job = fakeStore([{ threadId: "job", createdAt: 1, openedBy: { botId: "x" } }, { threadId: "new", createdAt: 2 }]);
    expect(markSideConversation(asStore(job), "b", "new")).toBe(false);
  });
});

describe("an empty /new conversation", () => {
  const tasks: Task[] = [
    { threadId: "main", createdAt: 1 },
    { threadId: "empty", createdAt: 2, side: true },
    { threadId: "written", createdAt: 3, side: true },
    { threadId: "pinned", createdAt: 4, side: true, pinned: true },
    { threadId: "open", createdAt: 5, side: true },
  ];

  it("is archived once the person leaves it without writing, and nothing else is", () => {
    const store = fakeStore(tasks, { written: true });
    const archived = archiveEmptySideConversations(asStore(store), "b", "main", () => false, 99);
    expect(archived).toEqual(["empty", "open"]);
    expect(store.list.find((task) => task.threadId === "empty")!.archivedAt).toBe(99);
    for (const kept of ["main", "written", "pinned"]) expect(store.list.find((task) => task.threadId === kept)!.archivedAt).toBeUndefined();
  });

  it("stays while it is the one open, and while it is working", () => {
    const store = fakeStore(tasks, { written: true });
    expect(archiveEmptySideConversations(asStore(store), "b", "empty", (id) => id === "open", 99)).toEqual([]);
  });
});
