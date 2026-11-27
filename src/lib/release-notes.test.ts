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
  it("is remembered until told, never on a fresh install, and not again once told", async () => {
    const { updateToTell, updateTold } = await import("./release-notes");
    const store = memory();
    expect(updateToTell("desktop", null, null, store)).toBeNull();
    expect(updateToTell("desktop", "0.2.32", "0.2.31", store)).toEqual({ from: "0.2.31", to: "0.2.32" });
    expect(updateToTell("desktop", null, null, store)).toEqual({ from: "0.2.31", to: "0.2.32" });
    updateTold("desktop", "0.2.32", store);
    expect(updateToTell("desktop", null, null, store)).toBeNull();
    expect(updateToTell("desktop", "0.2.32", "0.2.31", store)).toBeNull();
    expect(updateToTell("desktop", "0.2.33", "dev", store)).toEqual({ from: null, to: "0.2.33" });
  });
});
