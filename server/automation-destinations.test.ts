import { describe, expect, it } from "vitest";

import { createAutomationDestinations, type AutomationDestinationDeps } from "./automation-destinations.ts";
import { CLOUD_OUTSIDE_KEY } from "./cloud-sharing.ts";
import type { Routine } from "./routines.ts";

function world(writer: string) {
  const tasks = new Map<string, { threadId: string; title: string }>([["person-chat", { threadId: "person-chat", title: "Person" }], ["hook-chat", { threadId: "hook-chat", title: "Hook · Results" }],
    ["guest-chat", { threadId: "guest-chat", title: "Guest" }]]);
  const opened: Array<[string, string]> = [];
  const outside: string[] = [];
  let made = 0;
  const store = {
    bot: () => ({ id: "bot" }),
    createTask: (_botId: string, title: string) => { const task = { threadId: `made-${++made}`, title }; tasks.set(task.threadId, task); return task; },
    messagesFor: () => [],
    taskByThread: (_botId: string, threadId: string) => tasks.get(threadId),
  } as unknown as AutomationDestinationDeps["store"];
  const destinations = createAutomationDestinations({ store, mainThread: () => "main", runs: () => [],
    cloud: { owner: "owner", opener: () => writer, reportFromOthers: () => false, ownersChat: (threadId) => threadId !== "guest-chat", opened: (threadId, person) => { opened.push([threadId, person]); }, outside: (threadId) => { outside.push(threadId); } } });
  return { destinations, opened, outside };
}
const routine = { id: "r", name: "Daily", botId: "bot", resultsThreadId: "person-chat" } as Routine;

describe("where an automation reports on a Cloud", () => {
  it("keeps the chat a person's routine chose", () => {
    expect(world("p_someone").destinations.routine(routine, false)).toEqual({ threadId: "person-chat" });
  });

  it("gives a routine outside work wrote a chat of its own, whatever chat it names", () => {
    const w = world(CLOUD_OUTSIDE_KEY);
    expect(w.destinations.routine(routine, false)).toEqual({ threadId: "made-1" });
    expect(w.opened).toEqual([["made-1", CLOUD_OUTSIDE_KEY]]);
  });

  it("names an event's own chat, never a person's or the chat a wait reports to", () => {
    const { destinations } = world("owner");
    expect(destinations.eventChat({ botId: "bot", routineName: "Hook", resultsThreadId: "hook-chat" })).toBe("hook-chat");
    expect(destinations.eventChat({ botId: "bot", routineName: "Hook", resultsThreadId: "person-chat" })).toBeUndefined();
    expect(destinations.eventChat({ botId: "bot", routineName: "Hook", resultsThreadId: "hook-chat", eventSource: "wait" })).toBeUndefined();
  });

  it("records an event's own chat as holding outside work", () => {
    const w = world("owner");
    expect(w.destinations.event({ webhookId: "w", webhookName: "Hook", botId: "bot" })).toBe("made-1");
    expect(w.outside).toEqual(["made-1"]);
  });
});

function home(tasks: Array<{ threadId: string; title: string; archivedAt?: number; routineRunId?: string }>, team = false) {
  const byThread = new Map(tasks.map((task) => [task.threadId, task]));
  const store = {
    bot: (id: string) => (id === "bot" ? { id: "bot" } : { id }),
    createTask: () => null,
    messagesFor: () => [],
    taskByThread: (botId: string, threadId: string) => (botId === "bot" ? byThread.get(threadId) : undefined),
    groupByThread: () => undefined,
  } as unknown as AutomationDestinationDeps["store"];
  return createAutomationDestinations({ store, mainThread: () => "last-written", runs: () => [], cloud: null, team });
}

describe("where a routine made in a chat reports", () => {
  const made = { id: "r", name: "Stretch", botId: "bot", sourceThreadId: "set-here" } as Routine;
  const chats = [{ threadId: "set-here", title: "Planning" }, { threadId: "last-written", title: "Later" }];

  it("reports to the chat it was set in, not the one the person last wrote in", () => {
    expect(home(chats).routine(made, false)).toEqual({ threadId: "set-here" });
    expect(home(chats).sourceChat(made)).toBe("set-here");
  });

  it("follows the main chat once the chat it was set in is archived or deleted, and again after it comes back", () => {
    const archived = [{ ...chats[0], archivedAt: 1 }, chats[1]];
    expect(home(archived).routine(made, false)).toEqual({ threadId: "last-written", main: true });
    expect(home(archived).routine({ ...made, resultsThreadId: "set-here" }, false)).toEqual({ threadId: "last-written", main: true });
    expect(home([chats[1]]).routine(made, false)).toEqual({ threadId: "last-written", main: true });
    expect(home(chats).routine({ ...made, resultsThreadId: "set-here" }, false)).toEqual({ threadId: "set-here" });
  });

  it("keeps a chat chosen after it was made, and the main chat for one made in another bot's or a run's chat", () => {
    expect(home(chats).routine({ ...made, resultsThreadId: "last-written" }, false)).toEqual({ threadId: "last-written" });
    expect(home(chats).routine({ ...made, botId: "other" }, false)).toEqual({ threadId: "last-written", main: true });
    expect(home([{ ...chats[0], routineRunId: "run" }, chats[1]]).routine(made, false)).toEqual({ threadId: "last-written", main: true });
    expect(home(chats).routine({ ...made, sourceThreadId: undefined }, false)).toEqual({ threadId: "last-written", main: true });
  });

  it("on a Team Cloud reports to the shared chat as before", () => {
    expect(home(chats, true).routine(made, false)).toEqual({ threadId: "last-written", main: true });
  });

  it("on a Cloud, only for the owner's routine made in a chat no guest wrote in", () => {
    const owners = { ...made, sourceThreadId: "person-chat", resultsThreadId: undefined } as Routine;
    expect(world("owner").destinations.routine(owners, false)).toEqual({ threadId: "person-chat" });
    expect(world("owner").destinations.routine({ ...owners, sourceThreadId: "guest-chat" }, false)).toEqual({ threadId: "main", main: true });
    expect(world("p_someone").destinations.sourceChat(owners)).toBeUndefined();
  });
});

describe("where a routine made in a room reports", () => {
  const room = { id: "room", threadId: "room-main", memberIds: ["bot", "other"], tasks: [{ threadId: "room-main" }, { threadId: "room-side" }, { threadId: "room-old", archivedAt: 1 }] };
  const inRoom = (rooms: Array<typeof room & { dm?: boolean }>) => {
    const roomOf = (threadId: string) => rooms.find((candidate) => candidate.tasks.some((task) => task.threadId === threadId.replace(/:member:.*$/, "")));
    const store = {
      bot: (id: string) => ({ id }),
      createTask: () => null,
      messagesFor: () => [],
      taskByThread: () => undefined,
      groupByThread: roomOf,
      roomThreadOf: (threadId: string) => threadId.replace(/:member:.*$/, ""),
      groupTaskByThread: (groupId: string, threadId: string) => rooms.find((candidate) => candidate.id === groupId)?.tasks.find((task) => task.threadId === threadId),
    } as unknown as AutomationDestinationDeps["store"];
    return createAutomationDestinations({ store, mainThread: () => "main", runs: () => [], cloud: null });
  };
  const made = (sourceThreadId: string, botId = "bot") => ({ id: "r", name: "Standup", botId, sourceThreadId }) as Routine;

  it("reports to the room conversation it was made in, from a member's own run of it too", () => {
    expect(inRoom([room]).routine(made("room-main"), false)).toEqual({ threadId: "room-main" });
    expect(inRoom([room]).routine(made("room-side:member:bot"), false)).toEqual({ threadId: "room-side" });
  });

  it("falls back to the bot's main chat once the room or its conversation is gone, archived or the bot left", () => {
    expect(inRoom([room]).routine(made("room-old"), false)).toEqual({ threadId: "main", main: true });
    expect(inRoom([]).routine(made("room-main"), false)).toEqual({ threadId: "main", main: true });
    expect(inRoom([room]).routine(made("room-main", "left"), false)).toEqual({ threadId: "main", main: true });
    expect(inRoom([{ ...room, dm: true }]).routine(made("room-main"), false)).toEqual({ threadId: "main", main: true });
  });
});
