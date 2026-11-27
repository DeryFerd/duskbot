import { expect, it, vi } from "vitest";
import { setAppAway } from "@/lib/chat-in-front";
import { clearSeenNotifications, seenDelivered } from "./seen-notifications";

const delivered = [
  { id: "a", threadId: "t1", notificationId: "n1" },
  { id: "b", threadId: "t2", notificationId: "n2" },
  { id: "c", threadId: "t3", notificationId: "n3" },
  { id: "d" },
];
const feed = [{ id: "n1", read: false }, { id: "n2", read: true }, { id: "n3", read: false }];

it("clears pushes read on any device and the one for the conversation on screen, and keeps the rest", () => {
  expect(seenDelivered(delivered, feed, null)).toEqual(["b"]);
  expect(seenDelivered(delivered, feed, "t3")).toEqual(["b", "c"]);
  // a push for a notification this phone has not loaded yet stays
  expect(seenDelivered([{ id: "e", threadId: "t9", notificationId: "n9" }], feed, null)).toEqual([]);
});

it("asks the native layer to remove only what was seen, and nothing when nothing was", async () => {
  const removeDeliveredNotifications = vi.fn(async () => {});
  await clearSeenNotifications({ deliveredNotifications: async () => delivered, removeDeliveredNotifications }, feed, "t1");
  expect(removeDeliveredNotifications).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
  removeDeliveredNotifications.mockClear();
  await clearSeenNotifications({ deliveredNotifications: async () => delivered, removeDeliveredNotifications }, [], null);
  expect(removeDeliveredNotifications).not.toHaveBeenCalled();
});

it("keeps a push for the conversation the backgrounded app still shows, and clears it once the app is back", async () => {
  const removeDeliveredNotifications = vi.fn(async () => {});
  const phone = { deliveredNotifications: async () => delivered, removeDeliveredNotifications };
  setAppAway(true);
  try {
    await clearSeenNotifications(phone, feed, "t1");
    expect(removeDeliveredNotifications).toHaveBeenCalledExactlyOnceWith(["b"]);
  } finally {
    setAppAway(false);
  }
  removeDeliveredNotifications.mockClear();
  await clearSeenNotifications(phone, feed, "t1");
  expect(removeDeliveredNotifications).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
});
