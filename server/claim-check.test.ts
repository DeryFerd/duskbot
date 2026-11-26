import { describe, expect, it } from "vitest";

import { callEvidence, claimedDeeds, unbackedDeeds } from "./claim-check.ts";
import { TurnGates } from "./turn-stop-gates.ts";

describe("claimedDeeds", () => {
  it.each([
    ["Your Acme Robotics notes are ready for the **3:00 PM Eastern** Zoom with Lena.", ["save"]],
    ["I removed your old job from what I remember about you.", ["remove"]],
    ["Set up. Starting at 8:45 I'll check receipts@ every five minutes.", ["setup"]],
    ["Sent the refund note to Grace.", ["send"]],
    ["I've booked the dentist for Thursday at 10.", ["schedule"]],
    ["I've created a reminder for 2:15.", ["schedule"]],
    ["Your Acme Robotics briefing is ready. The call is with Lena.", ["save"]],
    ["I sent it to Grace when the draft was ready.", ["send"]],
  ])("hears %s", (text, deeds) => {
    expect(claimedDeeds(text)).toEqual(deeds);
  });

  it.each([
    "I haven't sent it yet: here is the draft.",
    "Want me to send it?",
    "Here are your notes:",
    "The notes are below.",
    "I can save this to your notes if you want.",
    "Once you say yes, I'll book it.",
    "The request was cancelled by the client.",
    "Current time when this message was sent: Thursday, 2026-11-26 20:03 Asia/Calcutta.",
  ])("hears no claim in %s", (text) => {
    expect(claimedDeeds(text)).toEqual([]);
  });
});

describe("callEvidence", () => {
  it("reads what a call could have done from its name, a bridged call by the tool it ran, memory by its action", () => {
    expect(callEvidence("notes__notes_create")).toEqual(["save"]);
    expect(callEvidence("gmail_send")).toEqual(["send"]);
    expect(callEvidence("gmail_create_draft")).toEqual(["save"]);
    expect(callEvidence("calendar_create_event")).toEqual(["schedule", "save"]);
    expect(callEvidence("agents_use_tool", JSON.stringify({ name: "memory_update", arguments: { action: "forget" } }))).toEqual(["remove"]);
    expect(callEvidence("memory_update", JSON.stringify({ action: "append" }))).toEqual(["save"]);
    expect(callEvidence("mcp_call_tool", JSON.stringify({ name: "gmail_gmail_send", arguments: { to: "a@b.test" } }))).toEqual(["send"]);
    expect(callEvidence("Bash")).toEqual(["shell"]);
  });

  it("holds a send claim to a send, while a saved note backs a 'saved' claim", () => {
    expect(unbackedDeeds(["send", "save"], new Set(callEvidence("sheets_create")))).toEqual(["send"]);
  });
});

describe("TurnGates: claims", () => {
  it("sends back 'notes are ready' when nothing was saved, once, and lets it end when a note was made", () => {
    const gates = new TurnGates();
    gates.mount(["notes_create", "notes_search", "crm_contact"]);
    gates.ran("notes_search", "{}", true, "[]");
    gates.ran("crm_contact", "{}", true, '{"name":"Lena Brandt"}');
    expect(gates.gate("Your Acme notes are ready for the 3:00 PM call.")).toContain("no tool call in this turn did that");
    expect(gates.gate("Your Acme notes are ready for the 3:00 PM call.")).toBeNull();
    const saved = new TurnGates();
    saved.mount(["notes_create", "notes_search"]);
    saved.ran("notes_create", "{}", true, '{"id":"n1","title":"Acme"}');
    expect(saved.gate("Your Acme notes are ready for the 3:00 PM call.")).toBeNull();
    const reminded = new TurnGates();
    reminded.mount(["notes_create", "trigger"]);
    reminded.ran("trigger", '{"action":"create"}', true, '{"id":"r1"}');
    expect(reminded.gate("Your Acme notes are ready for the 3:00 PM call.")).toContain("save it where they keep such things");
  });

  it("does not let an unrelated change back a 'sent' claim", () => {
    const gates = new TurnGates();
    gates.mount(["sheets_create", "gmail_send"]);
    gates.ran("sheets_create", "{}", true, '{"id":"s1"}');
    expect(gates.gate("Made the log sheet and forwarded the receipt to Penny.")).toContain("sent");
  });
});
