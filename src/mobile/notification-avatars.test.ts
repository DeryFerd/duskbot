import { describe, expect, it } from "vitest";
import { avatarLook, mascotSvg, NOTIFICATION_AVATAR_PX } from "./notification-avatars";

const nova = { id: "b1", name: "Nova", color: "green" as const };

describe("notification avatars", () => {
  it("draws a bot with no photo as its still mark on a disc of its colour", () => {
    const svg = mascotSvg(nova);
    expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${NOTIFICATION_AVATAR_PX}"`)).toBe(true);
    expect(svg).toMatch(/<path d="[^"]+" fill="#[0-9a-f]{6}"/i);
    expect(svg).not.toContain("var(");
  });

  it("draws again only when the bot's look changes", () => {
    expect(avatarLook(nova)).toBe(avatarLook({ ...nova, name: "Nova two" }));
    expect(avatarLook(nova)).not.toBe(avatarLook({ ...nova, color: "blue" }));
    expect(avatarLook(nova)).not.toBe(avatarLook({ ...nova, avatarUrl: "/api/attachments/a.png" }));
  });
});
