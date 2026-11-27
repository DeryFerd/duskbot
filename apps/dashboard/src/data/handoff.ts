// the desktop app's signed-in link to the website: /handoff#t=<token>. the token is a sign-in credential, so it lives in
// this module only (never storage) and leaves the address bar before anything renders.
import { appPath, withBase } from "../lib/router";

const TOKEN = /^#t=([A-Za-z0-9_-]{43})$/;
let kept: string | null = null, arrived = false;

export const HANDOFF_PATH = "/handoff";

/** on the handoff page: keeps the link's token and takes the fragment out of the address bar and history */
export function stashHandoff() {
  if (appPath(location.pathname) !== HANDOFF_PATH) return;
  if (location.hash) {
    const match = TOKEN.exec(location.hash);
    kept = match ? match[1]! : null;
    arrived = kept !== null;
    history.replaceState(null, "", location.pathname + location.search);
  }
}

export const handoffToken = () => kept;
/** whether this page load came from a handoff link with a token (before launch nothing else opens it) */
export const handoffArrived = () => arrived;
export function forgetHandoff() { kept = null; }

/** the page the service named, only ever one of ours: anything else goes home */
export const handoffNext = (next: unknown) => typeof next === "string" && /^\/(?:billing|cloud|account(?:#billing)?|usage)?(?:\?[A-Za-z0-9_=&-]*)?$/.test(next) ? next : "/";

/** a full load that replaces the handoff page, so every cached view starts again as the account the link signed in */
export function leaveHandoff(path: string) { location.replace(withBase(path)); }
