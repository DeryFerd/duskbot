// agent-browser 0.37 answers a page's alert and beforeunload itself, but a confirm or prompt stays open and unseen in its
// headless Chrome, which holds every input to that page until it is answered. A second DevTools client sees and answers
// it; it must enable the Page domain before the dialog opens, since a page blocked by one answers nothing.
import { connectCdp, type Cdp, type CdpListeners } from "./browser-sites.ts";

export interface PageDialog {
  type: "confirm" | "prompt";
  message: string;
  defaultValue: string;
}

/** Only the engine's own Chrome on this machine is ever addressed. */
export function localDevToolsUrl(value: unknown): string | null {
  return typeof value === "string" && /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/devtools\/browser\/[\w-]+$/u.test(value) ? value : null;
}

const MESSAGE_LIMIT = 2_000;
type Open = { session: string; dialog: PageDialog } | null;

/** One browser's open page dialog, watched over its own DevTools connection. */
export class DialogWatch {
  readonly #onChange: (dialog: PageDialog | null) => void;
  #cdp: Cdp | null = null;
  #open: Open = null;
  #waiters = new Set<() => void>();
  #closed = false;
  #opened = 0;

  constructor(onChange: (dialog: PageDialog | null) => void) {
    this.#onChange = onChange;
  }

  get dialog(): PageDialog | null { return this.#open?.dialog ?? null; }
  get closed(): boolean { return this.#closed; }
  /** How many dialogs have opened since the watch began. */
  get opened(): number { return this.#opened; }

  async start(url: string, connect: (url: string, timeoutMs: number, listeners: CdpListeners) => Promise<Cdp> = connectCdp): Promise<void> {
    const cdp = await connect(url, 10_000, {
      event: ({ method, params, sessionId }) => {
        if (method === "Target.attachedToTarget" && (params?.targetInfo as { type?: unknown } | undefined)?.type === "page" && typeof params?.sessionId === "string") {
          void cdp.send("Page.enable", {}, params.sessionId).catch(() => undefined);
        } else if (method === "Page.javascriptDialogOpening" && sessionId && (params?.type === "confirm" || params?.type === "prompt")) {
          this.#set({ session: sessionId, dialog: {
            type: params.type,
            message: String(params.message ?? "").slice(0, MESSAGE_LIMIT),
            defaultValue: String(params.defaultPrompt ?? "").slice(0, MESSAGE_LIMIT),
          } });
        } else if ((method === "Page.javascriptDialogClosed" || method === "Target.detachedFromTarget") && this.#open && (sessionId ?? params?.sessionId) === this.#open.session) {
          this.#set(null);
        }
      },
      closed: () => this.close(),
    });
    if (this.#closed) { cdp.close(); return; }
    this.#cdp = cdp;
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  #set(open: Open): void {
    if (open === null && this.#open === null) return;
    if (open) this.#opened += 1;
    this.#open = open;
    if (!open) { for (const done of this.#waiters) done(); this.#waiters.clear(); }
    this.#onChange(open?.dialog ?? null);
  }

  /** False when there was no dialog to answer, or the browser did not take the answer. */
  async answer(accept: boolean, promptText?: string): Promise<boolean> {
    const open = this.#open;
    if (!open || !this.#cdp) return false;
    try {
      await this.#cdp.send("Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined && open.dialog.type === "prompt" ? { promptText } : {}) }, open.session);
    } catch { return false; }
    if (this.#open === open) this.#set(null);
    return true;
  }

  /** Resolves once no dialog is open, the watch stops, or `signal` aborts. */
  settled(signal?: AbortSignal): Promise<void> {
    if (!this.#open || this.#closed || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { this.#waiters.delete(done); signal?.removeEventListener("abort", done); resolve(); };
      this.#waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cdp?.close();
    this.#cdp = null;
    this.#set(null);
  }
}

/** How the bot asked a call to answer a page question that call brings up: `dialog: "accept"`, with `promptText` for a
 * prompt. Anything else answers Cancel, so a "Delete this?" is never confirmed unless the bot said so. */
export interface DialogAnswer { accept: boolean; promptText?: string }

export function dialogAnswerOf(params: unknown): DialogAnswer {
  const args = (params as { arguments?: Record<string, unknown> } | null)?.arguments;
  const accept = args?.dialog === "accept" || args?.dialog === true;
  return { accept, ...(accept && typeof args?.promptText === "string" ? { promptText: args.promptText.slice(0, MESSAGE_LIMIT) } : {}) };
}

/** The call's params without the dialog answer, which is dusk bot's and never reaches the engine. */
export function withoutDialogAnswer(params: unknown): unknown {
  const record = params as { arguments?: unknown } | null;
  const args = record?.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args) || !("dialog" in args || "promptText" in args)) return params;
  const { dialog: _dialog, promptText: _promptText, ...rest } = args as Record<string, unknown>;
  return { ...record, arguments: rest };
}

/** What the bot is told after its call brought up a page question that dusk bot answered for it. */
export function dialogNote(dialog: PageDialog, answer: DialogAnswer): string {
  const asked = `The page asked ${JSON.stringify(dialog.message)} (a ${dialog.type} dialog)`;
  if (answer.accept) return `${asked} and dusk bot answered OK${dialog.type === "prompt" ? ` with ${JSON.stringify(answer.promptText ?? dialog.defaultValue)}` : ""}, as this call asked.`;
  return `${asked} and dusk bot answered Cancel so the page would not stay stuck, so it did not get a yes. To answer OK instead, make this same call again with "dialog": "accept"${dialog.type === "prompt" ? ' and "promptText": "your answer"' : ""}.`;
}

/** agent-browser 0.37.0 adds a warning naming an agent_browser_dialog tool it does not offer in the core set; once
 * dusk bot answered the dialog it is wrong twice over. */
export function withoutDialogWarning(result: unknown): unknown {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return result;
  return { ...result as object, content: content.map((part) => {
    const text = (part as { type?: unknown; text?: unknown } | null)?.type === "text" ? (part as { text: string }).text : null;
    if (!text?.includes("dialog is blocking the page")) return part;
    try {
      const { warning, ...rest } = JSON.parse(text) as Record<string, unknown>;
      return typeof warning === "string" && warning.includes("dialog is blocking the page") ? { ...part as object, text: JSON.stringify(rest) } : part;
    } catch { return part; }
  }) };
}
