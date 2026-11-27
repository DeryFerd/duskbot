// the production policy and rails on InstaBox's prices: starts cost nothing, a resume keeps memory, compute is the only
// cash. Pause/resume loops, routines across pauses and recovery from faults, seeded so a failure reproduces.
import { describe, expect, it } from "vitest";
import { hostTimeout } from "../../../../server/testing/host-timeout.ts";
import { INSTABOX_RAILS, instaboxCostProfile } from "../instabox.ts";
import { DAY, HOUR, MINUTE } from "./cost.ts";
import { MIX, PERSONAS } from "./personas.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import { DEFAULT_RAILS } from "./rails.ts";
import { adaptiveDecider, alwaysOnDecider, fixedIdleDecider, mulberry32, simulate, type Faults, type Persona, type SimUser } from "./sim.ts";

const START = Date.UTC(2026, 10, 2), SMALL = { vcpu: 2, ramGb: 4, diskGb: 40 }, RAILS = { ...DEFAULT_RAILS, ...INSTABOX_RAILS };
const PARAMS = { ...DEFAULT_POLICY, schedule: { ...DEFAULT_POLICY.schedule, leadMs: 2 * 60_000 }, rails: RAILS };
const profile = instaboxCostProfile();
function fleet(rand: () => number, n: number, persona?: Persona): SimUser[] {
  return Array.from({ length: n }, (_, i) => {
    let key = "grok";
    let x = rand();
    for (const [k, w] of MIX) { if ((x -= w) < 0) { key = k; break; } }
    return { id: `u${i}`, persona: persona ?? PERSONAS[key]!, tzHours: Math.floor(rand() * 24) - 11, spec: SMALL };
  });
}

describe("InstaBox: the policy on free starts and memory-keeping pauses", () => {
  it("costs less than always-on, every fixed idle timer and the rails for a scarce start pool for a mixed fleet, never misses a routine and never flaps", () => {
    const users = fleet(mulberry32(41), 40);
    const run = (decider: ReturnType<typeof adaptiveDecider>) => simulate({ users, days: 21, warmupDays: 7, start: START, profile, seed: 41, decider, caps: { hour: RAILS.maxStartsPerHour, day: RAILS.maxStartsPerDay } });
    const adaptive = run(adaptiveDecider(PARAMS)), pooledRails = run(adaptiveDecider()), always = run(alwaysOnDecider()), idle5 = run(fixedIdleDecider(5 * MINUTE)), idle30 = run(fixedIdleDecider(30 * MINUTE));
    const total = (r: typeof adaptive) => r.users.reduce((a, u) => a + u.computeCents + u.startCents + u.waitCents, 0);
    expect(adaptive.violations).toEqual([]);
    expect(adaptive.users.reduce((a, u) => a + u.runsMissed + u.runsLate, 0)).toBe(0);
    expect(adaptive.users.reduce((a, u) => a + u.startCents, 0)).toBe(0);
    expect(total(adaptive)).toBeLessThan(total(always) * 0.6);
    expect(total(adaptive)).toBeLessThanOrEqual(total(idle30));
    expect(total(adaptive)).toBeLessThan(total(idle5));
    expect(total(adaptive)).toBeLessThan(total(pooledRails) * 0.8);
    for (const u of adaptive.users) {
      expect(u.minStopGapMs).toBeGreaterThanOrEqual(RAILS.minUptimeMs);
      expect(u.maxStartsHour).toBeLessThanOrEqual(RAILS.maxStartsPerHour);
    }
  });

  it("a home whose routine runs every 10 minutes is woken for each run and paused between them, without a loop", () => {
    const frequent: Persona = { name: "frequent", plan: (_rand, m) => ({ events: [], runs: Array.from({ length: 144 }, (_, i) => ({ at: m + i * 10 * MINUTE, flexMs: 0, runMs: 45_000 })) }) };
    const result = simulate({ users: [{ id: "f", persona: frequent, tzHours: 0, spec: SMALL }], days: 4, warmupDays: 1, start: START, profile, seed: 3, decider: adaptiveDecider(PARAMS) });
    const u = result.users[0]!;
    expect(result.violations).toEqual([]);
    expect(u.runsMissed + u.runsLate).toBe(0);
    expect(u.maxStartsHour).toBeLessThanOrEqual(RAILS.maxStartsPerHour);
    // either up through the gaps or paused between runs, but never more starts than runs
    expect(u.starts).toBeLessThanOrEqual(u.runs + 4);
  });

  it("an inactive home stays paused: no wake without intent or a routine", () => {
    const quiet: Persona = { name: "quiet", plan: () => ({ events: [], runs: [] }) };
    const result = simulate({ users: [{ id: "q", persona: quiet, tzHours: 0, spec: SMALL }], days: 7, warmupDays: 1, start: START, profile, seed: 9, decider: adaptiveDecider(PARAMS) });
    const u = result.users[0]!;
    expect(u.starts).toBe(0);
    expect(u.awakeMs).toBeLessThan(2 * HOUR);
  });

  it("under failed resumes, limits, lost machines and crashes mid-pause: no pause during work, bounded starts, and it recovers", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = mulberry32(seed * 2_654_435);
      const faults: Faults = { startFail: rand() * 0.25, limit: rand() * 0.15, stuckStop: rand() * 0.1, stuckMs: 10 * MINUTE, lostPerHour: rand() * 0.05,
        duplicate: rand() * 0.3, skewMs: Math.floor(rand() * 2 * MINUTE), crashMidStop: rand() * 0.2 };
      const result = simulate({ users: fleet(rand, 12), days: 9, warmupDays: 7, start: START, profile, seed, decider: adaptiveDecider(PARAMS), faults, faultsUntil: START + 5 * DAY });
      expect(result.violations.filter(v => v.includes("stopped during") || v.includes("hard cap")), `seed ${seed}`).toEqual([]);
      for (const u of result.users) {
        expect(u.runsMissed + u.runsLate, `seed ${seed} ${u.id} recovered`).toBe(0);
        expect(u.maxStartsHour, `seed ${seed} ${u.id}`).toBeLessThanOrEqual(RAILS.maxStartsPerHour);
      }
    }
    // twelve nine-day fleets under faults: about 20 s of CPU on a laptop, over 40 s beside three other files on a runner
  }, hostTimeout(90_000));
});
