import { describe, expect, it } from "vitest";
import { notesForUpdate, updatedFrom } from "./release-notes";
import { parseChangelog } from "../../shared/release-notes";

function memory(): Storage {
  const map = new Map<string, string>();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value), removeItem: (key) => void map.delete(key), clear: () => map.clear(), key: () => null, get length() { return map.size; } };
}

describe("the line after an update", () => {
  it("comes once per update, never on a first install or a downgrade", () => {
    const store = memory();
    expect(updatedFrom("desktop", "0.2.31", store)).toBeNull();
    expect(updatedFrom("desktop", "0.2.31", store)).toBeNull();
    expect(updatedFrom("desktop", "0.2.32", store)).toBe("0.2.31");
    expect(updatedFrom("desktop", "0.2.32", store)).toBeNull();
    expect(updatedFrom("desktop", "0.2.30", store)).toBeNull();
    expect(updatedFrom("desktop", "dev", store)).toBeNull();
    expect(updatedFrom("desktop", "0.2.33", null)).toBeNull();
  });

  it("keeps each surface apart", () => {
    const store = memory();
    updatedFrom("desktop", "0.2.31", store);
    expect(updatedFrom("phone", "1.2.12", store)).toBeNull();
    expect(updatedFrom("phone", "1.2.13", store)).toBe("1.2.12");
  });

  it("has nothing to say when the changelog has nothing for this surface", () => {
    const releases = parseChangelog({ releases: [{ version: "0.2.32", items: [{ text: "phone only", area: "phone" }] }] });
    expect(notesForUpdate(releases, ["desktop"], "0.2.31", "0.2.32")).toEqual([]);
    expect(notesForUpdate([], ["desktop"], "0.2.31", "0.2.32")).toEqual([]);
    expect(notesForUpdate(releases, ["phone"], "0.2.31", "0.2.32").map((release) => release.version)).toEqual(["0.2.32"]);
  });
});

describe("once a launch", () => {
  it("answers a second ask the same, so a twice-run effect still says it", async () => {
    const { updatedThisLaunch, resetLaunchesForTests } = await import("./release-notes");
    const store = new Map<string, string>([["dusk-whats-new:twice", "1.2.9"]]);
    Object.defineProperty(globalThis, "window", { value: { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } }, configurable: true });
    resetLaunchesForTests();
    expect(updatedThisLaunch("twice", "1.2.12")).toBe("1.2.9");
    expect(updatedThisLaunch("twice", "1.2.12")).toBe("1.2.9");
    expect(store.get("dusk-whats-new:twice")).toBe("1.2.12");
  });
});

describe("New, Better and Fixed", () => {
  it("keeps a change's kind and icon when they are known ones, and drops odd ones", () => {
    const [release] = parseChangelog({ releases: [{ version: "0.2.32", items: [
      { text: "a", area: "all", kind: "new", icon: "cloud" },
      { text: "b", area: "all", kind: "shiny", icon: "rocket" },
    ] }] });
    expect(release!.items).toEqual([{ text: "a", area: "all", kind: "new", icon: "cloud" }, { text: "b", area: "all" }]);
  });

  it("groups in that order, unkinded changes as Better, and a release with no kinds as one list", async () => {
    const { groupChanges } = await import("./release-notes");
    const items = parseChangelog({ releases: [{ version: "0.2.32", items: [
      { text: "fix", area: "all", kind: "fixed" }, { text: "plain", area: "all" }, { text: "added", area: "all", kind: "new" },
    ] }] })[0]!.items;
    expect(groupChanges(items).map((group) => [group.kind, group.items.map((change) => change.text)])).toEqual([["new", ["added"]], ["better", ["plain"]], ["fixed", ["fix"]]]);
    expect(groupChanges(items.map(({ kind: _kind, ...rest }) => rest)).map((group) => group.kind)).toEqual([null]);
    expect(groupChanges([])).toEqual([]);
  });
});

describe("the update a surface still owes its notes for", () => {
  it("is owed only on a multiple of WHATS_NEW_EVERY, remembered until told, never on a fresh install", async () => {
    const { updateToTell, updateTold } = await import("./release-notes");
    const store = memory();
    expect(updateToTell("desktop", null, null, store)).toBeNull();
    expect(updateToTell("desktop", "0.2.33", "0.2.32", store)).toBeNull();
    expect(updateToTell("desktop", "0.2.34", "0.2.33", store)).toBeNull();
    expect(updateToTell("desktop", "0.2.35", "0.2.34", store)).toEqual({ from: "0.2.32", to: "0.2.35" });
    expect(updateToTell("desktop", null, null, store)).toEqual({ from: "0.2.32", to: "0.2.35" });
    updateTold("desktop", "0.2.35", store);
    expect(updateToTell("desktop", null, null, store)).toBeNull();
    expect(updateToTell("desktop", "0.2.35", "0.2.34", store)).toBeNull();
    expect(updateToTell("desktop", "0.2.36", "0.2.35", store)).toBeNull();
    expect(updateToTell("desktop", "0.2.39", "0.2.36", store)).toBeNull();
    expect(updateToTell("desktop", "0.2.43", "0.2.39", store)).toEqual({ from: "0.2.35", to: "0.2.43" });
  });

  it("is owed on a jump that crosses a multiple, and from the version the last notes left off", async () => {
    const { updateToTell } = await import("./release-notes");
    const store = memory();
    expect(updateToTell("desktop", "0.2.37", "0.2.33", store)).toEqual({ from: "0.2.33", to: "0.2.37" });
  });

  it("is owed on a fresh install of nothing and a version that is not one", async () => {
    const { updateToTell } = await import("./release-notes");
    expect(updateToTell("desktop", "0.2.35", "dev", memory())).toBeNull();
  });
});

describe("crossesMilestone", () => {
  it("reaches a multiple of 5 exactly, or passes one", async () => {
    const { crossesMilestone, WHATS_NEW_EVERY } = await import("./release-notes");
    expect(WHATS_NEW_EVERY).toBe(5);
    expect(crossesMilestone("0.2.34", "0.2.35")).toBe(true);
    expect(crossesMilestone("0.2.33", "0.2.37")).toBe(true);
    expect(crossesMilestone("0.2.38", "0.2.40")).toBe(true);
    expect(crossesMilestone("0.2.36", "0.2.39")).toBe(false);
    expect(crossesMilestone("0.2.32", "0.2.34")).toBe(false);
    expect(crossesMilestone("0.2.35", "0.2.36")).toBe(false);
    expect(crossesMilestone("0.2.39", "0.3.0")).toBe(true);
    expect(crossesMilestone("0.2.40", "0.2.35")).toBe(false);
  });

  it("shows a line written in several releases once, under the newest", () => {
    const releases = [
      { version: "0.2.35", items: [{ text: "Same.", area: "desktop" as const }, { text: "New one.", area: "desktop" as const }] },
      { version: "0.2.34", items: [{ text: "same.", area: "desktop" as const }] },
      { version: "0.2.33", items: [{ text: "Old.", area: "desktop" as const }] },
    ];
    expect(notesForUpdate(releases, ["desktop"], "0.2.32", "0.2.35").map((release) => [release.version, release.items.map((i) => i.text)])).toEqual([["0.2.35", ["Same.", "New one."]], ["0.2.33", ["Old."]]]);
  });
});
