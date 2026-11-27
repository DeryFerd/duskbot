import { describe, expect, it } from "vitest";
import { GLANCE_REST, GLANCE_STILL, GLANCE_SWAP_S, glanceEvents, glanceGaze, glanceLid, type GlanceEvent, type GlanceState } from "./working-glance";
import { WORKING_MOODS, type WorkingMood } from "./working-mood";

function play(mood: WorkingMood, seconds: number, seed = "s") {
  const out: GlanceEvent[] = [];
  for (const event of glanceEvents(mood, seed)) { if (event.at > seconds) break; out.push(event); }
  return out;
}

/** the states shown: changes due within the same few milliseconds land in one draw */
function statesOf(events: GlanceEvent[]) {
  const s: GlanceState = { ...GLANCE_REST };
  const out: Array<GlanceState & { at: number }> = [];
  for (const e of events) {
    Object.assign(s, e.set);
    if (out.length && e.at - out.at(-1)!.at < 0.002) out[out.length - 1] = { ...s, at: out.at(-1)!.at };
    else out.push({ ...s, at: e.at });
  }
  return out;
}

describe("the glance mascot's steps", () => {
  it("plans every step in time order and the same way for the same seed", () => {
    for (const mood of WORKING_MOODS) {
      const events = play(mood, 60);
      expect(events.length, mood).toBeGreaterThan(0);
      for (let i = 1; i < events.length; i++) expect(events[i]!.at, mood).toBeGreaterThanOrEqual(events[i - 1]!.at);
      expect(play(mood, 60)).toEqual(events);
    }
    expect(play("thinking", 30, "a")).not.toEqual(play("thinking", 30, "b"));
  });

  it("stays calm enough to watch: the eyes hold each look and nothing changes more than a few times a second", () => {
    for (const mood of WORKING_MOODS) {
      // the face shown before the swap of a step change is the one before, so its first moments are never seen
      const looks = statesOf(play(mood, 60)).filter((s, i, all) => s.at >= GLANCE_SWAP_S && (i === 0 || glanceGaze(s).join() !== glanceGaze(all[i - 1]!).join()));
      for (let i = 1; i < looks.length; i++) expect(looks[i]!.at - looks[i - 1]!.at, `${mood} holds a look`).toBeGreaterThanOrEqual(0.3);
      const changes = new Set(play(mood, 60).map((e) => Math.round(e.at * 10)));
      expect(changes.size / 60, `${mood} changes per second`).toBeLessThan(5);
    }
  });

  it("thinks by looking up, one way then another", () => {
    const ups = statesOf(play("thinking", 20)).filter((s) => s.holdX === null).map(glanceGaze);
    expect(ups.every(([, y]) => y === -1)).toBe(true);
    expect(new Set(ups.map(([x]) => x)).size).toBeGreaterThan(1);
  });

  it("reads along a line, three stops and a sweep back down", () => {
    const line = statesOf(play("reading", 1.1)).map(glanceGaze);
    expect(line.slice(-3)).toEqual([[-1, 0], [0, 0], [1, 0]]);
    const next = statesOf(play("reading", 1.2)).map(glanceGaze).at(-1);
    expect(next).toEqual([-1, 1]);
  });

  it("blinks with a quick close, a hold and an open, and never stays shut", () => {
    const lids = statesOf(play("searching", 30)).map(glanceLid);
    expect(Math.max(...lids)).toBe(1);
    expect(lids.at(-1)).toBeLessThan(1);
  });

  it("holds a face for every step without motion, and the failed step's is concerned", () => {
    for (const mood of WORKING_MOODS) expect(GLANCE_STILL[mood].kind, mood).toBeTruthy();
    expect(GLANCE_STILL.error.kind).toBe("sad");
    expect(GLANCE_STILL.done.kind).toBe("happy");
    expect(GLANCE_STILL.searching.kind).toBe("wide");
  });

  it("starts a reply with a pleased beat and a small lift that settles", () => {
    const s = statesOf(play("replying", 2));
    expect(s.find((x) => x.at === 0 && x.kind === "happy")?.rise).toBeGreaterThan(0);
    expect(s.at(-1)).toMatchObject({ kind: "open", rise: 0 });
  });
});
