const bridge = () => (typeof window === "undefined" ? undefined : window.duskDesktop?.rail);

/** Whether the page draws the window's frame: main puts the traffic lights in its top bar, or back where the window keeps
 * them without it. */
export function sayFrameDrawn(drawn = true): void {
  void bridge()?.drawsFrame?.(drawn)?.catch(() => {});
}
