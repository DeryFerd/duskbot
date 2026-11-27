import { describe, expect, it } from "vitest";

import { mainThread, oldestThread, wasOldestThread } from "./main-thread.ts";

const first = { threadId: "first", createdAt: 1 };
const later = { threadId: "later", createdAt: 2 };
const latest = { threadId: "latest", createdAt: 3 };

describe("a bot's main thread", () => {
  it("is the open thread a person last wrote in, wherever the selection is", () => {
    const tasks = [{ ...latest, askedAt: 10 }, { ...later, askedAt: 30 }, { ...first, askedAt: 20 }];
    expect(mainThread(tasks, "first")).toBe("later");
    expect(mainThread(tasks)).toBe("later");
  });

  it("is the thread the person chose while it is open, else the usual pick", () => {
    const tasks = [{ ...latest, askedAt: 10 }, { ...later, askedAt: 30 }, { ...first, askedAt: 20 }];
    expect(mainThread(tasks, "later", "first")).toBe("first");
    expect(mainThread([{ ...latest, archivedAt: 5 }, { ...later, askedAt: 30 }], "later", "latest")).toBe("later");
    expect(mainThread([{ ...latest, routineRunId: "run" }, later], "later", "latest")).toBe("later");
    expect(mainThread(tasks, "later", "deleted")).toBe("later");
  });

  it("stays the person's own chat when they last wrote from a chat app, unless the chat app's thread is all there is", () => {
    const telegram = { threadId: "telegram", createdAt: 4, askedAt: 50, chatApp: true };
    expect(mainThread([{ ...first, askedAt: 10 }, telegram], "first")).toBe("first");
    expect(mainThread([first, telegram], "first")).toBe("first");
    expect(mainThread([{ ...first, archivedAt: 5 }, telegram])).toBe("telegram");
    expect(mainThread([{ ...first, askedAt: 10 }, telegram], "first", "telegram")).toBe("telegram");
  });

  it("is never a routine run or an archived thread, however recently written in", () => {
    const tasks = [
      { ...latest, askedAt: 50, routineRunId: "run" },
      { ...later, askedAt: 40, archivedAt: 41 },
      { ...first, askedAt: 10 },
    ];
    expect(mainThread(tasks, "later")).toBe("first");
  });

  it("is the selected thread before anyone writes, while that is an open conversation", () => {
    expect(mainThread([latest, later, first], "later")).toBe("later");
    expect(mainThread([latest, { ...later, archivedAt: 5 }, first], "later")).toBe("first");
    expect(mainThread([{ ...latest, routineRunId: "run" }, later, first], "latest")).toBe("first");
    expect(mainThread([latest, later, first], "deleted")).toBe("first");
  });

  it("is the oldest archived thread when every thread is archived, and nothing without threads", () => {
    expect(mainThread([{ ...latest, archivedAt: 9, askedAt: 9 }, { ...later, archivedAt: 8 }], "latest")).toBe("later");
    expect(mainThread([{ ...first, routineRunId: "run" }])).toBeUndefined();
    expect(mainThread([])).toBeUndefined();
  });
});

describe("the oldest thread", () => {
  it("is the oldest open conversation, else the oldest archived one, never a routine run", () => {
    expect(oldestThread([latest, later, { ...first, routineRunId: "run" }])).toBe("later");
    expect(oldestThread([latest, { ...first, archivedAt: 4 }])).toBe("latest");
    expect(oldestThread([{ ...latest, archivedAt: 6 }, { ...later, archivedAt: 5 }])).toBe("later");
  });
});

describe("a thread saved on a routine as the oldest one", () => {
  it("is a conversation no open thread is older than, open still or archived since", () => {
    expect(wasOldestThread([latest, later, first], "first")).toBe(true);
    expect(wasOldestThread([latest, later, { ...first, archivedAt: 9 }], "first")).toBe(true);
    expect(wasOldestThread([latest, { ...later, archivedAt: 9 }, { ...first, archivedAt: 8 }], "later")).toBe(true);
    expect(wasOldestThread([latest, later, first], "later")).toBe(false);
    expect(wasOldestThread([latest, { ...later, archivedAt: 9 }, first], "later")).toBe(false);
    expect(wasOldestThread([latest, later, { ...first, routineRunId: "run" }], "later")).toBe(true);
    expect(wasOldestThread([latest, { ...later, routineRunId: "run" }], "later")).toBe(false);
    expect(wasOldestThread([latest, later], "deleted")).toBe(false);
  });
});

describe("a bot's main thread beside the jobs it opened (#336)", () => {
  const job = { threadId: "job", createdAt: 5, openedBy: { botId: "b", name: "Starter", at: 5 } };
  it("stays the person's own chat after they write in a job the bot opened", () => {
    expect(mainThread([{ ...first, askedAt: 10 }, { ...job, askedAt: 20 }], "job")).toBe("first");
  });
  it("is not a job just because it is selected", () => {
    expect(mainThread([first, job], "job")).toBe("first");
  });
  it("is a job only when the person chose it, or when no chat of their own is open", () => {
    expect(mainThread([{ ...first, askedAt: 10 }, { ...job, askedAt: 20 }], "job", "job")).toBe("job");
    expect(mainThread([{ ...first, archivedAt: 3 }, { ...job, askedAt: 20 }], "job")).toBe("job");
  });
});
