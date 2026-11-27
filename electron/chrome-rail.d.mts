export declare const CHROME_RAIL_PATH: string;
export declare const FRAME_GRACE_MS: number;
/** `window.duskDesktop.rail`. `drawsFrame()` from a document in the window says it draws the window's frame, so main puts
 * the traffic lights in its top bar; `drawsFrame(false)`, that it draws none (the person turned the frame off), so they go
 * back at once. `expand` and `onSkin` are the sheet page's own, on this app's pages only. Each is absent on an older app. */
export interface ChromeRailBridge {
  /** Stubs for pages of older releases: there is never a rail to hide. */
  state?(): Promise<{ available: false; hidden: false }>;
  setHidden?(hidden: boolean): Promise<{ available: false; hidden: false }>;
  onState?(callback: (state: { available: boolean; hidden: boolean }) => void): () => void;
  onFramed?(callback: (framed: boolean) => void): () => void;
  drawsFrame?(drawn?: boolean): Promise<void>;
  expand?(on: boolean): Promise<void>;
  onSkin?(callback: (skin: string) => void): () => void;
}
export interface ChromeRail {
  attach(window: unknown): void;
  refresh(): void;
  holdOpen(on: boolean): void;
  expand(on: boolean): void;
  owns(event: unknown): boolean;
  shown(): boolean;
  framed(): boolean;
  send(channel: string, ...values: unknown[]): void;
  install(ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void }): void;
}
export declare function createChromeRail(deps: {
  createView: (options: object) => any;
  preload: string;
  args: () => string[];
  url: () => string;
  prefs?: () => { windowFrame?(): boolean } | null;
  log?: (line: string) => void;
}): ChromeRail;
