import type { CSSProperties } from "react";

/** A small dialog drawn as the Settings sheet: on a narrow window Settings itself goes full screen, a small one stays a
 * centred card on its dim. */
export const compactSheetStyle = (width: number): CSSProperties => ({
  width: `min(${width}px, 100vw - 32px)`,
  height: "auto",
  maxHeight: "calc(100dvh - 32px)",
  alignSelf: "center",
  borderRadius: 14,
  background: "var(--settings-sheet)",
});

export const compactBackdropStyle: CSSProperties = { display: "block" };
