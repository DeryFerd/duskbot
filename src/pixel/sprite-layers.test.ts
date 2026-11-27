import { describe, expect, it } from "vitest";
import { PIXEL_BODY_IDS } from "../../shared/pixel-bodies";
import { stillSvgPaths } from "./engine";
import { spriteLayers, type EyeKind } from "./sprite-layers";

const cells = (d: string) => {
  const out = new Set<string>();
  for (const m of d.matchAll(/M(-?\d+) (-?\d+)h(\d+)/g)) for (let i = 0; i < Number(m[3]); i++) out.add(`${Number(m[1]) + i},${m[2]}`);
  return out;
};

describe("the mascot split into moving parts", () => {
  it("draws every body exactly as its still sprite when nothing is turned", () => {
    for (const body of PIXEL_BODY_IDS) {
      const s = spriteLayers(body);
      const drawn = cells(s.base + s.layers.map((l) => l.at(0)).join(""));
      expect(drawn, body).toEqual(cells(stillSvgPaths(body, { scale: 1 }).body));
    }
  });

  it("turns each ear, antenna, leaf or tuft on the same pixel grid and keeps it whole", () => {
    for (const body of PIXEL_BODY_IDS) for (const layer of spriteLayers(body).layers) for (const deg of [-12, 6, 18, 30]) {
      expect(cells(layer.at(deg)).size, `${body} at ${deg}`).toBeGreaterThan(0);
    }
    expect(spriteLayers("kit").layers.map((l) => l.side).sort()).toEqual([-1, 1]);
  });

  it("keeps every face on the body for every body and every look it is asked for", () => {
    const kinds: EyeKind[] = ["open", "wide", "happy", "sad", "closed"];
    for (const body of PIXEL_BODY_IDS) {
      const s = spriteLayers(body);
      const solid = cells(s.base);
      for (const k of kinds) for (const lid of [0, 0.34, 1]) for (const [x, y] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1], [-1, 0], [1, 0], [0, 1], [0, -1]]) {
        const [gx, gy] = s.clamp(k === "closed" || k === "sad" ? "open" : k, x!, y!);
        const eye = { k, lid, lidB: 0 };
        const [l, r] = s.eyes(eye, eye, gx, gy);
        expect(l.length > 0 && r.length > 0, `${body} ${k}`).toBe(true);
        for (const c of [...cells(l), ...cells(r)]) {
          const [cx, cy] = c.split(",").map(Number);
          expect(solid.has(`${cx! + gx},${cy! + gy}`), `${body} ${k} lid ${lid} at ${gx},${gy}`).toBe(true);
        }
      }
    }
  });

  it("lets the eyes look up and to each side on the default body", () => {
    const s = spriteLayers("kit");
    expect(s.clamp("open", 1, -1)).toEqual([1, -1]);
    expect(s.clamp("open", -1, 1)).toEqual([-1, 1]);
  });
});
