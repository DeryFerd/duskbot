import type { ReleaseIcon, ReleaseKind } from "@/lib/release-notes";

const INK = { v: "#894ef0", l: "#c9a6f0", y: "#f2c933", p: "#f48fbf", b: "#4fb6ec", w: "#ffffff", g: "#8fd14f", o: "#fb9a3c", c: "#f6ead0" } as const;
type Ink = keyof typeof INK;

/** 12 by 12 cells each: a letter is a colour of INK, "." is empty */
export const CHANGE_GLYPHS: Record<ReleaseIcon, readonly string[]> = {
  spark: ["............", ".....v......", ".....v......", "....vvv.....", "..vvvvvvv...", "....vvv.....", ".....v...l..", ".....v..lll.", ".........l..", "............", "............", "............"],
  bolt: ["............", "......yy....", ".....yy.....", "....yy......", "...yyyyyy...", "......yy....", ".....yy.....", "....yy......", "...y........", "............", "............", "............"],
  check: ["............", "............", "..........g.", ".........gg.", "........gg..", ".g.....gg...", ".gg...gg....", "..gg.gg.....", "...ggg......", "....g.......", "............", "............"],
  cloud: ["............", "............", ".....bbb....", "....bbbbb...", "..bb.bbbbb..", ".bbbbbbbbbb.", "bbbbbbbbbbbb", "bbbbbbbbbbbb", ".bbbbbbbbbb.", "............", "............", "............"],
  chat: ["............", "..llllllll..", ".llllllllll.", ".llvlvlvlll.", ".llllllllll.", "..llllllll..", "...ll.......", "..l.........", "............", "............", "............", "............"],
  phone: ["...bbbbbb...", "...bwwwwb...", "...bwppwb...", "...bwwwwb...", "...bwwwwb...", "...bwwwwb...", "...bwwwwb...", "...bbbbbb...", "...bbwwbb...", "...bbbbbb...", "............", "............"],
  file: ["............", ".pppp.......", ".ppppppppp..", ".pppppppppp.", ".yyyyyyyyyy.", ".pppppyyppp.", ".pppppyyppp.", ".pppppppppp.", ".pppppppppp.", "............", "............", "............"],
  photo: ["............", ".bbbbbbbbbb.", ".bwwwwwwwwb.", ".bwwwwwyywb.", ".bwwwwwyywb.", ".bwwgwwwwwb.", ".bwgggwwwwb.", ".bgggggwgwb.", ".bggggggggb.", ".bbbbbbbbbb.", "............", "............"],
  key: ["............", "..yyyy......", ".yy..yy.....", ".y....y.....", ".yy..yy.....", "..yyyyyyyyy.", "........y.y.", "........y.y.", "............", "............", "............", "............"],
  moon: ["............", "....yyy.....", "...yy.......", "..yy........", "..yy........", "..yy........", "..yyy....v..", "...yyyyy.vv.", "....yyy...v.", "............", "............", "............"],
  eraser: ["............", "......pppp..", ".....ppppp..", "....ppppp...", "...ppppp....", "..cccpp.....", "..ccccp.....", "...cc.......", "............", "..vvvvvvvv..", "............", "............"],
  bell: ["............", ".....yy.....", "....yyyy....", "...yyyyyy...", "...yyyyyy...", "...yyyyyy...", "..yyyyyyyy..", ".yyyyyyyyyy.", "............", ".....oo.....", "............", "............"],
  eye: ["............", "............", "...vvvvvv...", "..vwwwwwwv..", ".vwwwvvwwwv.", ".vwwvvvvwwv.", ".vwwwvvwwwv.", "..vwwwwwwv..", "...vvvvvv...", "............", "............", "............"],
};

const KIND_ICON: Record<ReleaseKind, ReleaseIcon> = { new: "spark", better: "bolt", fixed: "check" };

function paths(rows: readonly string[]): [Ink, string][] {
  const byInk = new Map<Ink, string>();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ink = row[x] as Ink | ".";
      if (ink === ".") continue;
      byInk.set(ink, `${byInk.get(ink) ?? ""}M${x} ${y}h1v1h-1z`);
    }
  });
  return [...byInk];
}

/** a change's small pixel picture, on a soft tile */
export function ChangeIcon({ icon, kind }: { icon?: ReleaseIcon; kind?: ReleaseKind }) {
  const rows = CHANGE_GLYPHS[icon ?? KIND_ICON[kind ?? "new"]];
  return (
    <span aria-hidden="true" data-change-icon={icon ?? kind ?? "new"}
      className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-[color-mix(in_srgb,#894ef0_10%,transparent)]">
      <svg width="18" height="18" viewBox="0 0 12 12" shapeRendering="crispEdges">
        {paths(rows).map(([ink, d]) => <path key={ink} d={d} fill={INK[ink]} />)}
      </svg>
    </span>
  );
}
