import { useEffect } from "react";
import { appAway } from "@/lib/chat-in-front";
import type { NotificationLogEntry } from "../../../shared/notification";
import type { DeliveredNotification, MobilePlatform } from "../platform";

/** Pushes still in Notification Center that the person has already seen: about the conversation on screen, or read on
 * any device (the desktop, this phone, "mark all read"). */
export function seenDelivered(
  delivered: readonly DeliveredNotification[],
  feed: readonly Pick<NotificationLogEntry, "id" | "read">[],
  viewing: string | null,
): string[] {
  const read = new Set(feed.filter((entry) => entry.read).map((entry) => entry.id));
  return delivered
    .filter((one) => (viewing !== null && one.threadId === viewing) || (one.notificationId !== undefined && read.has(one.notificationId)))
    .map((one) => one.id);
}

/** A conversation the backgrounded app still shows is not being read: its pushes stay until the person comes back. */
export async function clearSeenNotifications(platform: Pick<MobilePlatform, "deliveredNotifications" | "removeDeliveredNotifications">, feed: readonly Pick<NotificationLogEntry, "id" | "read">[], viewing: string | null): Promise<void> {
  if (!platform.deliveredNotifications || !platform.removeDeliveredNotifications) return;
  const seen = seenDelivered(await platform.deliveredNotifications(), feed, appAway() ? null : viewing);
  if (seen.length) await platform.removeDeliveredNotifications(seen);
}

/** Tells the native layer which conversation is on screen, and clears pushes once seen: when the conversation opens,
 * when a read lands from another device, and each time the app comes back. */
export function useSeenNotifications(platform: MobilePlatform, feed: readonly NotificationLogEntry[], viewing: string | null): void {
  useEffect(() => { platform.setViewingThread?.(viewing); }, [platform, viewing]);
  useEffect(() => () => platform.setViewingThread?.(null), [platform]);
  useEffect(() => { void clearSeenNotifications(platform, feed, viewing); }, [platform, feed, viewing]);
  useEffect(() => platform.onResume?.(() => { void clearSeenNotifications(platform, feed, viewing); }), [platform, feed, viewing]);
  const unread = feed.reduce((count, entry) => count + (entry.read ? 0 : 1), 0);
  useEffect(() => { platform.setBadge?.(unread); }, [platform, unread]);
}
