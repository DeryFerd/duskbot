import { describe, expect, it } from "vitest";
import { bareAck, claimsDone, MAX_STOP_GATES, TurnGates, openChecklist, promisesFollowUp, ranTool, readBackWrite, schedulesCall, schedulesWork, settleAsks, stopGateFor, stopGateNote, type Ask, type StopGate, type TurnForAsks, type TurnSoFar } from "./turn-stop-gates.ts";

const turn = (over: Partial<TurnSoFar>): TurnSoFar => ({ reply: "", applied: new Set(), canSchedule: true, scheduled: false, effectful: 0, unconfirmed: null, ...over });

describe("promisesFollowUp", () => {
  it.each([
    "The flight is $420 today. I'll keep an eye on it and let you know if it drops.",
    "Done for now.\n\nI'll let you know when the package ships.",
    "I'll remind you tomorrow at 9.",
    "I've started a background job to rebuild the index.",
    "I'm going to check back in an hour.",
  ])("hears a promise of later work: %s", (text) => {
    expect(promisesFollowUp(text)).toBe(true);
  });

  it.each([
    "Want me to keep an eye on it?",
    "If you want, I'll remind you tomorrow.",
    "Let me know if I should check back later.",
    "The price is $420. Nothing else to do.",
    "I'll be here if you need anything.",
    "I reminded you about it yesterday.",
    "You said \"I'll remind you tomorrow\" was what the old bot told you.",
    "Type `I'll check back tomorrow` to test it.",
    "I checked it yesterday and again this morning: still pending.",
    "Si quieres, te aviso cuando llegue.",
    "I'll send it now.",
  ])("leaves offers and plain answers alone: %s", (text) => {
    expect(promisesFollowUp(text)).toBe(false);
  });

  it.each([
    "I've set a reminder for 9:00 tomorrow.",
    "Reminder set for Friday at 5 PM.",
    "I'll check on the delivery tomorrow morning.",
    "I'll send you the summary in 2 hours.",
    "Got it. I'll ping you at 5pm.",
    "I'll keep you posted.",
    "I'll come back to this next week.",
    "Ich melde mich morgen.",
    "Te aviso cuando llegue el paquete.",
    "Te recordaré mañana a las 9.",
  ])("hears an intention promised or claimed with nothing behind it: %s", (text) => {
    expect(promisesFollowUp(text)).toBe(true);
  });
});

describe("schedulesCall", () => {
  it("counts a trigger only when it sets something up, through the bridge too", () => {
    expect(schedulesCall("trigger", '{"action":"create","when":"schedule"}')).toBe(true);
    expect(schedulesCall("mcp__agents__trigger", '{"action":"resume","trigger_id":"r1"}')).toBe(true);
    expect(schedulesCall("wait_until", '{"label":"the build"}')).toBe(true);
    expect(schedulesCall("trigger", '{"action":"pause","trigger_id":"r1"}')).toBe(false);
    expect(schedulesCall("trigger", '{"action":"note","note":"x"}')).toBe(false);
    expect(schedulesCall("use_tool", '{"name":"trigger","arguments":{"action":"fail"}}')).toBe(false);
    expect(schedulesCall("use_tool", '{"name":"trigger","arguments":{"action":"create"}}')).toBe(true);
    expect(schedulesCall("read_file", "{}")).toBe(false);
  });

  it("does not let a paused automation stand in for the reminder it promised", () => {
    const gates = new TurnGates();
    gates.mount(["trigger", "wait_until"]);
    gates.ran("trigger", '{"action":"pause","trigger_id":"r1"}', true, "Paused");
    expect(gates.gate("Paused it. I'll remind you tomorrow to turn it back on.")).toContain("promises to do something later");
    const scheduled = new TurnGates();
    scheduled.mount(["trigger", "wait_until"]);
    scheduled.ran("wait_until", '{"label":"the deck","kind":"time","minutes":1440}', true, "Waiting");
    expect(scheduled.gate("I'll remind you tomorrow.")).toBeNull();
  });
});

describe("openChecklist", () => {
  it("returns the open items of a checklist with work ticked off", () => {
    expect(openChecklist("Progress:\n- [x] Saved the receipt\n- [ ] Save the invoice\n- [ ] Email the summary")).toEqual(["Save the invoice", "Email the summary"]);
  });

  it("ignores a plan with nothing done, items waiting on the person, and a closing question", () => {
    expect(openChecklist("- [ ] One\n- [ ] Two")).toBeNull();
    expect(openChecklist("- [x] Drafted\n- [ ] Waiting for your approval")).toBeNull();
    expect(openChecklist("- [x] Drafted\n- [ ] Send it\n\nShall I send it?")).toBeNull();
    expect(openChecklist("- [x] All done")).toBeNull();
  });
});

describe("tool helpers", () => {
  it("knows the tools that set up later work, bridged ones included", () => {
    expect(schedulesWork("wait_until")).toBe(true);
    expect(schedulesWork("mcp__agents__background_job")).toBe(true);
    expect(schedulesWork("agents_trigger")).toBe(true);
    expect(schedulesWork("delete_trigger")).toBe(false);
    expect(schedulesWork("list_waits")).toBe(false);
    expect(ranTool("use_tool", '{"name":"wait_until","arguments":{}}')).toBe("wait_until");
    expect(ranTool("use_tool", "not json")).toBe("use_tool");
  });

  it("tells a bare ok from an answer that shows the result", () => {
    for (const text of ["ok", "OK.", "", "{}", '{"ok":true}', '{"status":"success"}', "true", "204"]) expect(bareAck(text)).toBe(true);
    for (const text of ["Stored receipt=done", '{"id":"evt_1","status":"confirmed"}', "Created event Lunch at 1pm"]) expect(bareAck(text)).toBe(false);
  });
});

describe("stopGateFor", () => {
  it("sends a promise back only when a scheduling tool is mounted and none ran", () => {
    const reply = "I'll let you know when it ships.";
    expect(stopGateFor(turn({ reply }))?.gate).toBe("follow_up");
    expect(stopGateFor(turn({ reply, canSchedule: false }))).toBeNull();
    expect(stopGateFor(turn({ reply, scheduled: true }))).toBeNull();
  });

  it("sends an open checklist back only after the turn changed something", () => {
    const reply = "- [x] Saved\n- [ ] Send the invoice";
    expect(stopGateFor(turn({ reply }))).toBeNull();
    expect(stopGateFor(turn({ reply, effectful: 1 }))).toMatchObject({ gate: "checklist", note: expect.stringContaining("Send the invoice") });
  });

  it("asks for one look at a change whose tool only said ok", () => {
    expect(stopGateFor(turn({ reply: "Updated.", unconfirmed: "calendar_update" }))).toMatchObject({ gate: "unconfirmed_write", note: expect.stringContaining("calendar_update") });
  });

  it("takes each gate once and at most MAX_STOP_GATES in a turn", () => {
    const reply = "- [x] Saved\n- [ ] Send the invoice\n\nI'll let you know when it ships.";
    const applied = new Set<StopGate>();
    const all = { reply, effectful: 1, unconfirmed: "x_write" };
    for (let index = 0; index < MAX_STOP_GATES; index++) {
      const gate = stopGateFor(turn({ ...all, applied }));
      expect(gate).not.toBeNull();
      applied.add(gate!.gate);
    }
    expect([...applied]).toEqual(["follow_up", "checklist"]);
    expect(stopGateFor(turn({ ...all, applied }))).toBeNull();
  });
});

describe("TurnGates", () => {
  it("tracks the turn's calls: a bare ok after a change needs a look, a lookup after it clears that, a wait makes a promise good", () => {
    const gates = new TurnGates();
    gates.mount(["cal_update", "cal_get", "wait_until"]);
    gates.ran("cal_update", "{}", true, "ok");
    gates.ran("cal_get", "{}", true, '{"title":"Lunch"}');
    expect(gates.gate("Moved lunch to 1pm.")).toBeNull();
    gates.ran("cal_update", "{}", true, "ok");
    expect(gates.gate("Moved lunch to 1pm.")).toContain("cal_update");
    expect(gates.gate("Moved lunch to 1pm.")).toBeNull();
    gates.ran("wait_until", "{}", true, "Wait set");
    expect(gates.gate("I'll let you know when it moves.")).toBeNull();
    expect([...gates.applied]).toEqual(["unconfirmed_write"]);
  });

  it("never asks for a look when no lookup on the same server is mounted, and a routine's run never promises", () => {
    const gates = new TurnGates();
    gates.mount(["mail_send", "wait_until"], true);
    gates.ran("mail_send", "{}", true, "ok");
    expect(gates.gate("Sent. I'll let you know when they reply.")).toBeNull();
  });

  it("backs a claim with an app tool run through tool search's call_tool", () => {
    const gates = new TurnGates();
    gates.mount(["agents_set_status", "mcp_search_tools", "mcp_describe_tool", "mcp_call_tool"]);
    gates.ran("mcp_search_tools", JSON.stringify({ query: "post a slack message" }), true, "{}");
    gates.ran("mcp_describe_tool", JSON.stringify({ name: "slack_slack_post" }), true, "{}");
    gates.ran("mcp_call_tool", JSON.stringify({ name: "slack_slack_post", arguments: { channel: "eng", text: "CI is red" } }), true, '{"ok":true,"ts":"1796097631.468"}');
    expect(gates.gate("Posted the CI summary in #eng.")).toBeNull();
    expect(gates.applied.size).toBe(0);
  });
});

describe("honest status words", () => {
  it.each(["Done.", "All set, the invoice is updated.", "That's taken care of.", "Fixed it: the row now reads 42."])("hears a claim of done: %s", (text) => {
    expect(claimsDone(text)).toBe(true);
  });
  it.each(["Drafted it, nothing sent yet.", "Not done yet: waiting on the bank.", "Once you approve, it's done.", "Is that done?", "Sent the email to Ana."])("leaves other states alone: %s", (text) => {
    expect(claimsDone(text)).toBe(false);
  });

  it("sends a done claim back when the last app change was never read back, whatever its tool answered", () => {
    const gates = new TurnGates();
    gates.mount(["mcp__sheets__update_row", "mcp__sheets__get_row"]);
    gates.ran("mcp__sheets__update_row", "{}", true, '{"updatedRange":"A2:C2"}');
    expect(gates.gate("Sent you the summary above.")).toBeNull();
    expect(gates.gate("Done, the row is updated.")).toContain("changed something");
    expect(gates.applied.has("unconfirmed_write")).toBe(true);
  });

  it("lets done stand after a read-back, after a send, and with no way to read", () => {
    const read = new TurnGates();
    read.mount(["mcp__sheets__update_row", "mcp__sheets__get_row"]);
    read.ran("mcp__sheets__update_row", "{}", true, '{"updatedRange":"A2:C2"}');
    read.ran("mcp__sheets__get_row", "{}", true, "A2: 42");
    expect(read.gate("Done.")).toBeNull();

    const sent = new TurnGates();
    sent.mount(["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"]);
    sent.ran("GMAIL_SEND_EMAIL", "{}", true, '{"id":"m1"}');
    expect(sent.gate("Done, it's on its way.")).toBeNull();

    const blind = new TurnGates();
    blind.mount(["mcp__door__unlock"]);
    blind.ran("mcp__door__unlock", "{}", true, "unlocked");
    expect(blind.gate("Done.")).toBeNull();
  });

  it("takes dusk bot's own receipt for a profile or memory change as the record, bridged or not", () => {
    const bridged = new TurnGates();
    bridged.mount(["find_tool", "use_tool"]);
    bridged.ran("use_tool", JSON.stringify({ name: "propose_profile", arguments: { soul: "Refunds up to 5,000 are automatic." } }), true, "Applied: the profile change.");
    expect(bridged.gate("Updated the manual: refunds up to 5,000 are automatic now.")).toBeNull();
    expect(readBackWrite("mcp__dusk-agents__propose_profile")).toBe(false);
    expect(readBackWrite("mcp__dusk-agents__memory_update")).toBe(false);
    expect(readBackWrite("mcp__sheets__update_row")).toBe(true);
  });
});

describe("settleAsks", () => {
  const ask = (id: string, text: string): Ask => ({ id, text, state: "open" });
  const turn = (said: string[], over: Partial<TurnForAsks> = {}): TurnForAsks => ({ said, scheduled: false, handedOff: false, ...over });

  it("delivers a lone ask with any real answer, and keeps it open on an acknowledgement alone", () => {
    expect(settleAsks([ask("a", "what's 18% of 2450")], turn(["18% of 2450 is 441."]))).toEqual([{ id: "a", state: "delivered" }]);
    expect(settleAsks([ask("a", "what's 18% of 2450")], turn(["On it, checking now."]))).toEqual([]);
    expect(settleAsks([ask("a", "what's 18% of 2450")], turn([]))).toEqual([]);
    expect(settleAsks([ask("a", "thanks!")], turn(["Anytime."]))).toEqual([{ id: "a", state: "delivered" }]);
    expect(settleAsks([ask("a", "send that email")], turn(["Which email do you mean?"]))).toEqual([{ id: "a", state: "blocked" }]);
  });

  it("with several asks, delivers those the words take up and leaves the rest open", () => {
    const asks = [ask("a", "a one-line caption for my bakery's diwali post"), ask("b", "what's the weather in mumbai in july")];
    expect(settleAsks(asks, turn(["Caption: Sweet lights, sweeter bites this Diwali at our bakery!"]))).toEqual([{ id: "a", state: "delivered" }]);
  });

  it("marks an ask waiting when the turn set up later work, and blocked when the words name what stops it", () => {
    expect(settleAsks([ask("a", "remind me tomorrow at 9 to call my CA")], turn(["I'll remind you tomorrow at 9."], { scheduled: true }))).toEqual([{ id: "a", state: "waiting" }]);
    expect(settleAsks([ask("a", "message Ramesh on whatsapp")], turn(["WhatsApp isn't connected, so I couldn't send it. Here's a draft."]))).toEqual([{ id: "a", state: "blocked" }]);
    expect(settleAsks([ask("a", "x"), ask("b", "dig through the quarterly invoices")], turn(["Handed it to a thread of its own."], { handedOff: true }))).toEqual([{ id: "a", state: "waiting" }, { id: "b", state: "waiting" }]);
  });

  it("names the open asks in the note it sends back", () => {
    const note = stopGateNote("open_items", { items: ["what's the weather in mumbai in july"] });
    expect(note).toContain('"what\'s the weather in mumbai in july"');
    expect(note).toContain("still needs their yes");
  });
});
