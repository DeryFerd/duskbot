import type { MobileOpenTarget } from "../../shared/mobile-link";
import type { NativeAction } from "./phone-actions";

/** A push the bot host sent: its ids in a `dusk` or `omb` block (APNs), or flat in FCM's data with the kind beside them. */
export function fromBotHost(data: Record<string, unknown>): boolean {
  if (["dusk", "omb"].some((key) => data[key] && typeof data[key] === "object")) return true;
  return typeof data.kind === "string" && typeof data.threadId === "string" && (typeof data.botId === "string" || typeof data.groupId === "string");
}

/** An older link's push, with `bot`, `thread` and the like at the top level. */
export function linkTarget(data: Record<string, unknown>): MobileOpenTarget {
  const target: MobileOpenTarget = {};
  const fields = { env: "environmentId", bot: "botId", group: "groupId", thread: "threadId", message: "messageId" } as const;
  for (const [field, key] of Object.entries(fields)) {
    if (typeof data[field] === "string") target[key] = data[field];
  }
  switch (data.view) {
    case "chat": case "computer": case "profile": case "routines": case "settings": case "notifications":
      target.view = data.view;
  }
  return target;
}

const KEPT = 8;

/** Every notification tap and button press, from one native subscription. A cold start delivers the tap that opened the
 * app to whichever native listener comes first, so there is exactly one; what arrives before the page listens waits
 * for its first listener. */
export function createNotificationTaps() {
  const actionListeners = new Set<(action: NativeAction) => void>();
  const openListeners = new Set<(target: MobileOpenTarget) => void>();
  const actions: NativeAction[] = [];
  const opens: MobileOpenTarget[] = [];
  const keep = <T,>(list: T[], item: T) => { list.push(item); if (list.length > KEPT) list.shift(); };

  return {
    feed(action: NativeAction) {
      if (action.actionId !== "tap" || fromBotHost(action.data)) {
        if (actionListeners.size) for (const listener of actionListeners) listener(action);
        else keep(actions, action);
        return;
      }
      const target = linkTarget(action.data);
      if (openListeners.size) for (const listener of openListeners) listener(target);
      else keep(opens, target);
    },
    onAction(listener: (action: NativeAction) => void): () => void {
      actionListeners.add(listener);
      for (const action of actions.splice(0)) listener(action);
      return () => { actionListeners.delete(listener); };
    },
    onOpen(listener: (target: MobileOpenTarget) => void): () => void {
      openListeners.add(listener);
      for (const target of opens.splice(0)) listener(target);
      return () => { openListeners.delete(listener); };
    },
  };
}
