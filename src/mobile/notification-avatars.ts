import { createElement, useEffect, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotAvatar, type BotAvatarProps } from "@/components/Avatar";
import { MASCOT_INK } from "@/lib/mascot";
import { botAvatarProfile, clampAvatarFocus, clampAvatarZoom } from "../../shared/bot-avatar";
import type { MobilePlatform, NotificationAvatar } from "./platform";

type AvatarBot = BotAvatarProps["bot"] & { id: string };

/** The notification icon's edge, in pixels: what Android's conversation icon and iOS's attachment thumbnail draw. */
export const NOTIFICATION_AVATAR_PX = 128;
const KEY = "dusk.mobile.notificationAvatars";
const SETTLE_MS = 1500;

/** What the picture depends on, so it is drawn again only when the bot's look changes. */
export function avatarLook(bot: AvatarBot): string {
  return [bot.id, bot.avatarUrl ?? "", bot.avatarCrop ?? "", bot.avatarZoom ?? "", bot.avatarFocusX ?? "", bot.avatarFocusY ?? "", bot.color, bot.mascotBody ?? "", bot.mascotFaceColor ?? ""].join("|");
}

/** The bot's still mark as an SVG document, on a soft disc of its own colour (the mark is pixel art with flat paint). */
export function mascotSvg(bot: AvatarBot, size = NOTIFICATION_AVATAR_PX): string {
  const mark = renderToStaticMarkup(createElement(BotAvatar, { bot: { ...bot, avatarUrl: null }, size, animated: false }));
  const inner = mark.match(/<svg[\s\S]*<\/svg>/)?.[0];
  if (!inner) return "";
  const left = /left:(-?\d+)px/.exec(mark)?.[1] ?? "0", top = /top:(-?\d+)px/.exec(mark)?.[1] ?? "0";
  const ink = MASCOT_INK[bot.color] ?? MASCOT_INK.green;
  const placed = inner.replace("<svg", `<svg x="${left}" y="${top}"`).replace(/ style="[^"]*"/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<rect width="${size}" height="${size}" fill="#f4f4f2"/><rect width="${size}" height="${size}" fill="${ink}" fill-opacity="0.14"/>${placed}</svg>`;
}

async function bitmapOf(blob: Blob): Promise<CanvasImageSource | null> {
  if (typeof createImageBitmap === "function") return await createImageBitmap(blob).catch(() => null);
  return null;
}

async function imageOf(svg: string): Promise<CanvasImageSource | null> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("svg")); image.src = url; });
    return image;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The bot's picture as base64 PNG: its photo where it has one, cropped as the app shows it, else its mark. */
export async function drawNotificationAvatar(bot: AvatarBot): Promise<string | null> {
  const size = NOTIFICATION_AVATAR_PX;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const { avatarUrl } = botAvatarProfile(bot);
  let photo: CanvasImageSource | null = null;
  if (avatarUrl) {
    try {
      const response = await fetch(avatarUrl, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) photo = await bitmapOf(await response.blob());
    } catch { photo = null; }
  }
  if (photo && "width" in photo && typeof photo.width === "number" && typeof photo.height === "number" && photo.width > 0) {
    const width = photo.width, height = photo.height as number;
    const zoom = clampAvatarZoom(bot.avatarZoom ?? 1);
    const cover = Math.max(size / width, size / height) * zoom;
    const fx = clampAvatarFocus(bot.avatarFocusX ?? 0.5), fy = clampAvatarFocus(bot.avatarFocusY ?? 0.5);
    const drawnW = width * cover, drawnH = height * cover;
    context.drawImage(photo, (size - drawnW) * fx, (size - drawnH) * fy, drawnW, drawnH);
  } else {
    const svg = mascotSvg(bot, size);
    const image = svg ? await imageOf(svg) : null;
    if (!image) return null;
    context.drawImage(image, 0, 0, size, size);
  }
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

/** Keeps the bots' pictures where the system's notification code reads them while the app is closed, drawn again only
 * when a bot's look changes. */
export function useNotificationAvatars(platform: MobilePlatform, bots: readonly AvatarBot[]): void {
  const looks = bots.map(avatarLook).join("\n");
  const latest = useRef(bots);
  latest.current = bots;
  useEffect(() => {
    const cache = platform.cacheNotificationAvatars;
    if (!cache || !looks) return;
    let stopped = false;
    const timer = setTimeout(() => void (async () => {
      if (await platform.prefs.get(KEY) === looks) return;
      const avatars: NotificationAvatar[] = [];
      for (const bot of latest.current) {
        if (stopped) return;
        const png = await drawNotificationAvatar(bot).catch(() => null);
        if (png) avatars.push({ botId: bot.id, png });
      }
      if (stopped) return;
      await cache(avatars);
      await platform.prefs.set(KEY, looks);
    })().catch(() => {}), SETTLE_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [platform, looks]);
}
