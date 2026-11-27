import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { changedRect, encodeGif } from "./gif.mjs";
import { parsePrName, parseRawName, planReframe } from "./jobs.mjs";
import { BACKGROUNDS, cropPixels, parseCrop, planLayout, planTimeline } from "./layout.mjs";

/** A plain GIF89a reader: every frame composited onto the canvas, as palette colours. */
function decodeGif(bytes) {
  const text = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  const word = (at) => bytes[at] | (bytes[at + 1] << 8);
  const width = word(6);
  const height = word(8);
  const palette = bytes.subarray(13, 13 + 768);
  let at = 13 + 768;
  let loops = null;
  let delay = 0;
  const canvas = new Uint8Array(width * height);
  const frames = [];
  const subBlocks = () => {
    const data = [];
    while (bytes[at] !== 0) { data.push(...bytes.subarray(at + 1, at + 1 + bytes[at])); at += 1 + bytes[at]; }
    at += 1;
    return data;
  };
  while (bytes[at] !== 0x3b) {
    if (bytes[at] === 0x21 && bytes[at + 1] === 0xff) {
      const name = text(at + 3, 11);
      at += 14;
      const data = subBlocks();
      if (name === "NETSCAPE2.0") loops = data[1] | (data[2] << 8);
    } else if (bytes[at] === 0x21 && bytes[at + 1] === 0xf9) {
      delay = word(at + 4);
      at += 8;
    } else if (bytes[at] === 0x2c) {
      const rect = { x: word(at + 1), y: word(at + 3), width: word(at + 5), height: word(at + 7) };
      const minCodeSize = bytes[at + 10];
      at += 11;
      const data = subBlocks();
      const clear = 1 << minCodeSize;
      let codeSize = minCodeSize + 1;
      let table = [];
      const reset = () => { table = Array.from({ length: clear + 2 }, (_, code) => (code < clear ? [code] : [])); codeSize = minCodeSize + 1; };
      reset();
      const pixels = [];
      let buffer = 0;
      let bits = 0;
      let previous = null;
      for (const byte of data) {
        buffer |= byte << bits;
        bits += 8;
        while (bits >= codeSize) {
          const code = buffer & ((1 << codeSize) - 1);
          buffer >>= codeSize;
          bits -= codeSize;
          if (code === clear) { reset(); previous = null; continue; }
          if (code === clear + 1) break;
          const entry = code < table.length ? table[code] : [...previous, previous[0]];
          pixels.push(...entry);
          if (previous && table.length < 4096) table.push([...previous, entry[0]]);
          if (table.length === 1 << codeSize && codeSize < 12) codeSize += 1;
          previous = entry;
        }
      }
      expect(pixels.length).toBe(rect.width * rect.height);
      for (let y = 0; y < rect.height; y += 1) {
        for (let x = 0; x < rect.width; x += 1) canvas[(rect.y + y) * width + rect.x + x] = pixels[y * rect.width + x];
      }
      frames.push({ rect, delay, rgb: [...canvas].map((index) => [...palette.subarray(index * 3, index * 3 + 3)]) });
    } else {
      throw new Error(`unexpected GIF block 0x${bytes[at].toString(16)} at ${at}`);
    }
  }
  return { signature: text(0, 6), width, height, loops, frames };
}

function solidFrame(width, height, paint) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgba.set([...paint(x, y), 255], (y * width + x) * 4);
  }
  return rgba;
}

describe("the GIF encoder", () => {
  it("writes a looping GIF a decoder reads back, storing only what changed after the first frame", () => {
    const width = 96;
    const height = 64;
    const sky = [40, 160, 240];
    const ink = [16, 16, 24];
    const red = [248, 56, 48];
    const first = solidFrame(width, height, (x, y) => (x >= 16 && x < 80 && y >= 16 && y < 48 ? ink : sky));
    const second = solidFrame(width, height, (x, y) => (x >= 40 && x < 56 && y >= 24 && y < 40 ? red : x >= 16 && x < 80 && y >= 16 && y < 48 ? ink : sky));
    const gif = decodeGif(encodeGif({ width, height, frames: [{ rgba: first, delayMs: 1400 }, { rgba: second, delayMs: 80 }] }));

    expect(gif).toMatchObject({ signature: "GIF89a", width, height, loops: 0 });
    expect(gif.frames.map((frame) => frame.delay)).toEqual([140, 8]);
    expect(gif.frames[0].rect).toEqual({ x: 0, y: 0, width, height });
    expect(gif.frames[1].rect).toEqual({ x: 40, y: 24, width: 16, height: 16 });
    const near = (actual, wanted) => actual.every((value, channel) => Math.abs(value - wanted[channel]) <= 8);
    expect(near(gif.frames[0].rgb[0], sky)).toBe(true);
    expect(near(gif.frames[0].rgb[32 * width + 48], ink)).toBe(true);
    expect(near(gif.frames[1].rgb[32 * width + 48], red)).toBe(true);
    expect(near(gif.frames[1].rgb[20 * width + 20], ink)).toBe(true);
  });

  it("survives more distinct runs than the LZW table holds", () => {
    const width = 256;
    const height = 128;
    let seed = 7;
    const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed & 0xff; };
    const rgba = solidFrame(width, height, () => [noise(), noise(), noise()]);
    const gif = decodeGif(encodeGif({ width, height, frames: [{ rgba, delayMs: 100 }, { rgba, delayMs: 100 }] }));
    expect(gif.frames).toHaveLength(2);
    expect(gif.frames[1].rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("finds the rectangle that changed", () => {
    const before = new Uint8Array(20);
    const after = Uint8Array.from(before);
    after[1 * 5 + 2] = 1;
    after[3 * 5 + 4] = 1;
    expect(changedRect(before, after, 5, 4)).toEqual({ x: 2, y: 1, width: 3, height: 3 });
    expect(changedRect(before, before, 5, 4)).toBeNull();
  });
});

describe("the layout", () => {
  it("leaves a retina capture's pixels alone and centres it with generous padding", () => {
    const layout = planLayout({ shots: [{ width: 2560, height: 1600 }], density: 2 });
    const [{ rect }] = layout.shots;
    expect(rect).toMatchObject({ width: 2560, height: 1600 });
    expect(rect.x).toBe((layout.width - 2560) / 2);
    expect(rect.y).toBe((layout.height - 1600) / 2);
    expect(rect.x).toBeGreaterThanOrEqual(144);
    expect(layout.radius).toBe(24);
  });

  it("widens the canvas for a tall phone capture", () => {
    const layout = planLayout({ shots: [{ width: 780, height: 1688 }], density: 2 });
    expect(layout.width / layout.height).toBeCloseTo(4 / 3, 2);
  });

  it("puts a before and after pair side by side with a label under each", () => {
    const layout = planLayout({ shots: [{ width: 800, height: 600 }, { width: 800, height: 600 }], density: 2, labelled: true });
    const [before, after] = layout.shots;
    expect(after.rect.x).toBeGreaterThan(before.rect.x + before.rect.width);
    expect(before.rect.y).toBe(after.rect.y);
    expect(before.label.y).toBeGreaterThan(before.rect.y + before.rect.height);
    expect(before.label).toMatchObject({ anchor: "center", x: before.rect.x + 400 });
    expect(layout).toMatchObject({ arrange: "row", columnScale: 0.91 });
  });

  it("stacks a pair one above the other, each under its own label, on a canvas no wider than it needs", () => {
    const layout = planLayout({ shots: [{ width: 2560, height: 1600 }, { width: 2000, height: 1200 }], density: 2, arrange: "stack", labelled: true });
    const [before, after] = layout.shots;
    expect(before.label).toMatchObject({ anchor: "start", x: before.rect.x });
    expect(before.rect.y).toBeGreaterThan(before.label.y + before.label.height);
    expect(after.label.y).toBeGreaterThan(before.rect.y + before.rect.height);
    expect(after.rect.y).toBeGreaterThan(after.label.y + after.label.height);
    expect(after.rect.x + after.rect.width / 2).toBe(before.rect.x + before.rect.width / 2);
    expect(layout.width).toBe(2560 + before.rect.x * 2);
    expect(layout.height).toBe(after.rect.y + after.rect.height + before.label.y);
  });

  it("chooses the row while a pull request's column keeps it readable, and the stack once it does not", () => {
    const pair = (width, height) => planLayout({ shots: [{ width, height }, { width, height }], density: 2, labelled: true });
    expect(pair(960, 1320)).toMatchObject({ arrange: "row" });
    expect(pair(960, 1320).columnScale).toBeGreaterThanOrEqual(0.66);
    expect(pair(1100, 700)).toMatchObject({ arrange: "row" });
    expect(pair(1440, 900)).toMatchObject({ arrange: "stack", columnScale: 1 });
    expect(pair(2880, 1800)).toMatchObject({ arrange: "stack" });
    expect(pair(2880, 1800).columnScale).toBeGreaterThan(planLayout({ shots: [{ width: 2880, height: 1800 }, { width: 2880, height: 1800 }], arrange: "row" }).columnScale);
    expect(planLayout({ shots: [{ width: 2880, height: 1800 }] })).toMatchObject({ arrange: "row" });
  });

  it("never widens a tall pair past what the column keeps readable", () => {
    const layout = planLayout({ shots: [{ width: 576, height: 1800 }, { width: 576, height: 1800 }], density: 2, labelled: true });
    expect(layout).toMatchObject({ arrange: "row", columnScale: 0.66 });
  });

  it("reads a crop in points and keeps exactly those pixels", () => {
    expect(parseCrop("40, 120,560,360")).toEqual({ x: 40, y: 120, width: 560, height: 360 });
    for (const bad of ["", "40,120,560", "40,120,560,0", "-1,0,10,10", "a,b,c,d", "1,2,3,4,5", "1,,3,4"]) expect(parseCrop(bad)).toBeNull();
    const shot = { width: 2880, height: 1800 };
    expect(cropPixels(parseCrop("40,120,560,360"), shot, 2)).toEqual({ x: 80, y: 240, width: 1120, height: 720 });
    expect(cropPixels(null, shot, 2)).toEqual({ x: 0, y: 0, width: 2880, height: 1800 });
    expect(cropPixels(parseCrop("0,0,1440,900"), shot, 2)).toEqual({ x: 0, y: 0, width: 2880, height: 1800 });
    expect(() => cropPixels(parseCrop("1000,0,560,360"), shot, 2)).toThrow(/reaches outside a 1440 × 900 point capture/);
  });

  it("gives every animation frame the same slot", () => {
    const layout = planLayout({ shots: [{ width: 800, height: 600 }, { width: 800, height: 600 }, { width: 800, height: 600 }], arrange: "overlay" });
    expect(new Set(layout.shots.map((shot) => JSON.stringify(shot.rect))).size).toBe(1);
  });

  it("loops an animation back into its first frame", () => {
    const frames = planTimeline({ count: 3, holdMs: 1000, fadeMs: 300, fadeSteps: 3 });
    expect(frames).toHaveLength(12);
    expect(frames[0]).toEqual({ from: 0, to: 1, mix: 0, delayMs: 1000 });
    expect(frames.at(-1)).toMatchObject({ from: 2, to: 0, delayMs: 100 });
    expect(planTimeline({ count: 2, fadeMs: 0 })).toHaveLength(2);
  });

  it("ships its three backgrounds", () => {
    expect(Object.keys(BACKGROUNDS)).toEqual(["1", "2", "3"]);
    for (const file of Object.values(BACKGROUNDS)) {
      expect(existsSync(fileURLToPath(new URL(`./backgrounds/${file}`, import.meta.url)))).toBe(true);
    }
  });
});

describe("the naming convention", () => {
  it("reads a raw capture's slug and state", () => {
    expect(parseRawName("chat-stop.after.raw.png")).toEqual({ slug: "chat-stop", state: "after", frame: null });
    expect(parseRawName("chat-stop.f02-ask.raw.png")).toEqual({ slug: "chat-stop", state: "f02-ask", frame: { order: 2, label: "ask" } });
    expect(parseRawName("chat-stop.after.png")).toBeNull();
    expect(parseRawName("Chat Stop.after.raw.png")).toBeNull();
  });

  it("plans a still per capture, a pair for before and after, and a GIF for numbered frames", () => {
    const jobs = planReframe("/a", [
      "stop.after.raw.png", "stop.before.raw.png", "stop.before.png", "notes.txt",
      "demo.f02-ask.raw.png", "demo.f01-open.raw.png", "demo.f10-reply.raw.png", "lone.f01.raw.png",
    ]);
    expect(jobs.map((job) => [job.kind, basename(job.out), job.labels])).toEqual([
      ["animation", "demo.gif", ["open", "ask", "reply"]],
      ["still", "stop.after.png", []],
      ["still", "stop.before.png", []],
      ["still", "stop.before-after.png", ["before", "after"]],
    ]);
    expect(jobs[0].shots.map((shot) => basename(shot))).toEqual(["demo.f01-open.raw.png", "demo.f02-ask.raw.png", "demo.f10-reply.raw.png"]);
    expect(jobs[3].shots.map((shot) => basename(shot))).toEqual(["stop.before.raw.png", "stop.after.raw.png"]);
  });

  it("reads the pr-<n> naming and leaves the framed files it yields alone", () => {
    expect(parsePrName("pr-12-before.png")).toEqual({ slug: "pr-12", state: "before", variant: "" });
    expect(parsePrName("pr-13-after-2599.png")).toEqual({ slug: "pr-13", state: "after", variant: "2599" });
    expect(parsePrName("pr-11-after-two-bots.png")).toEqual({ slug: "pr-11", state: "after", variant: "two-bots" });
    for (const framed of ["pr-12-before-framed.png", "pr-13-after-2599-framed.png", "pr-12-before-after.png", "pr-13-before-after-2599.png", "pr-12.gif", "pr-12-before.gif", "before-after.png"]) {
      expect(parsePrName(framed)).toBeNull();
    }
  });

  it("reframes a pr-<n> folder into the names its pull request already links", () => {
    const jobs = planReframe("/a", [
      "pr-13-before.png", "pr-13-after.png", "pr-13-before-2599.png", "pr-13-after-2599.png", "pr-13-after-phone.png",
      "pr-13-before-framed.png", "pr-13-before-after.png", "pr-13-before-after-2599.png", "pr-13.gif", "before-after.png",
    ]);
    const made = Object.fromEntries(jobs.map((job) => [basename(job.out), [job.shots.map((shot) => basename(shot)), job.labels]]));
    expect(made).toEqual({
      "pr-13-after-framed.png": [["pr-13-after.png"], []],
      "pr-13-before-framed.png": [["pr-13-before.png"], []],
      "pr-13-before-after.png": [["pr-13-before.png", "pr-13-after.png"], ["before", "after"]],
      "pr-13-after-2599-framed.png": [["pr-13-after-2599.png"], []],
      "pr-13-before-2599-framed.png": [["pr-13-before-2599.png"], []],
      "pr-13-before-after-2599.png": [["pr-13-before-2599.png", "pr-13-after-2599.png"], ["before", "after"]],
      "pr-13-after-phone-framed.png": [["pr-13-after-phone.png"], []],
    });
  });

  it("gives each framed file the crop, arrangement and labels frame.json names for it", () => {
    const names = ["stop.before.raw.png", "stop.after.raw.png"];
    const jobs = planReframe("/a", names, {
      "stop.before-after.png": { crop: ["0,0,400,300", null], arrange: "stack", labels: ["main", "this branch"] },
      "stop.after.png": { crop: "10,20,30,40" },
    });
    const job = (out) => jobs.find((candidate) => basename(candidate.out) === out);
    expect(job("stop.before-after.png")).toMatchObject({
      crops: [{ x: 0, y: 0, width: 400, height: 300 }, null], arrange: "stack", labels: ["main", "this branch"],
    });
    expect(job("stop.after.png").crops).toEqual([{ x: 10, y: 20, width: 30, height: 40 }]);
    expect(job("stop.before.png")).toMatchObject({ crops: [null], labels: [] });
    expect(job("stop.before.png")).not.toHaveProperty("arrange");
    const [closer] = planReframe("/a", names, { "stop.closer.png": { shots: names, crop: "5,5,50,50", labels: ["before", "after"] } }).slice(-1);
    expect(closer).toMatchObject({ kind: "still", out: join("/a", "stop.closer.png"), shots: [join("/a", "stop.before.raw.png"), join("/a", "stop.after.raw.png")], labels: ["before", "after"] });
    expect(() => planReframe("/a", names, { "stop.closer.png": { shots: ["gone.raw.png"] } })).toThrow(/has no gone\.raw\.png/);
    expect(() => planReframe("/a", names, { "stop.after.png": { shots: names } })).toThrow(/takes no shots/);
    expect(() => planReframe("/a", names, { "stop.gif": {} })).toThrow(/does not yield: stop\.gif/);
    expect(() => planReframe("/a", names, { "stop.after.png": { crop: "wide" } })).toThrow(/not "x,y,width,height"/);
    expect(() => planReframe("/a", names, { "stop.before-after.png": { crop: ["0,0,1,1", "0,0,1,1", "0,0,1,1"] } })).toThrow(/one per shot \(2\)/);
    expect(() => planReframe("/a", names, { "stop.after.png": { arrange: "pile" } })).toThrow(/arrange/);
    expect(() => planReframe("/a", names, { "stop.after.png": { zoom: 2 } })).toThrow(/unknown option zoom/);
  });

  it("lets frame.json pick a GIF's frames and its timing", () => {
    const names = ["tab.f01-search.raw.png", "tab.f02-new-bot.raw.png", "tab.f03-pepper.raw.png", "tab.after.raw.png"];
    const gif = (options) => planReframe("/a", names, { "tab.gif": options }).find((job) => job.kind === "animation");
    expect(gif({ frames: ["tab.f03-pepper.raw.png", "tab.f01-search.raw.png"], hold: 900, fade: 0, crop: "0,0,300,200" })).toMatchObject({
      shots: [join("/a", "tab.f03-pepper.raw.png"), join("/a", "tab.f01-search.raw.png")], labels: ["pepper", "search"], holdMs: 900, fadeMs: 0,
      crops: [{ x: 0, y: 0, width: 300, height: 200 }, { x: 0, y: 0, width: 300, height: 200 }],
    });
    const whole = gif({});
    expect(whole.shots).toHaveLength(3);
    expect(whole).not.toHaveProperty("holdMs");
    expect(() => gif({ frames: ["tab.f01-search.raw.png"] })).toThrow(/at least two/);
    expect(() => gif({ frames: ["tab.f01-search.raw.png", "tab.after.raw.png"] })).toThrow(/do not include tab\.after\.raw\.png/);
    expect(() => gif({ hold: 5 })).toThrow(/hold of at least 20/);
    expect(() => planReframe("/a", names, { "tab.after.png": { hold: 900 } })).toThrow(/is a still and takes no hold/);
  });
});
