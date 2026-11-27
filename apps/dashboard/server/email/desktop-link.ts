import type { IncomingMessage, ServerResponse } from "node:http";
import { isTestAddress, type Mailer } from "../auth/mail.ts";
import { desktopLinkEmail, type EmailConfig } from "./templates.ts";

/** dusk.bot on a phone: the visitor types their own address and gets the desktop download link, to open on their computer.
 *  no account, nothing kept but counts. answers { ok: true } or { ok: false, error }; the page falls back to the mail app
 *  on anything but bad_email */
export const DESKTOP_LINK_PATH = "/api/public/desktop-link";
/** per network an hour, per address a day, and every address together a day (DUSK_DESKTOP_LINK_DAILY), so the route can
 *  never eat the sign-in codes' share of the mail providers' caps */
export const DESKTOP_LINK_LIMITS = { perIpHour: 5, perAddressDay: 2, daily: 100 } as const;
const HOUR = 3_600_000, DAY = 24 * HOUR;
// addresses that cannot get mail (rfc 2606 and 6761), apart from the test sink's own domain
const RESERVED = /\.(?:test|invalid|example|localhost|local)$/;

export type DesktopLinkError = "bad_email" | "too_many" | "mail_off";
export function cleanLinkAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)) return null;
  if (RESERVED.test(email) && !isTestAddress(email)) return null;
  return email;
}

export interface DesktopLinkOptions {
  mailer: Mailer;
  email: EmailConfig;
  json(res: ServerResponse, status: number, data: unknown): void;
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
  /** the address a limit counts against */
  ip(req: IncomingMessage): string;
  now?: () => number;
  daily?: number;
  log?: (line: string) => void;
}

export function createDesktopLink(options: DesktopLinkOptions) {
  const now = options.now ?? Date.now, log = options.log ?? (line => console.log(line));
  const daily = Number.isSafeInteger(options.daily) && options.daily! > 0 ? options.daily! : DESKTOP_LINK_LIMITS.daily;
  const byIp = new Map<string, number[]>(), byAddress = new Map<string, number[]>();
  let day = { key: "", sent: 0 };
  const within = (map: Map<string, number[]>, key: string, span: number) => {
    const time = now(), recent = (map.get(key) ?? []).filter(at => at > time - span);
    if (map.size > 10_000) for (const [k, list] of map) if (!list.some(at => at > time - DAY)) map.delete(k);
    map.set(key, recent);
    return recent;
  };
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== DESKTOP_LINK_PATH) return false;
    if (req.method !== "POST") { res.setHeader("allow", "POST"); options.json(res, 405, { ok: false, error: "method" }); return true; }
    const answer = (status: number, error?: DesktopLinkError) => options.json(res, status, error ? { ok: false, error } : { ok: true });
    const tries = within(byIp, options.ip(req), HOUR);
    if (tries.length >= DESKTOP_LINK_LIMITS.perIpHour) { answer(429, "too_many"); return true; }
    tries.push(now());
    const data = await options.readJson(req);
    const to = cleanLinkAddress(data.email);
    if (!to) { answer(400, "bad_email"); return true; }
    // a filled honeypot is a form-filling robot: it hears yes and nothing goes out
    if (typeof data.website === "string" && data.website.trim()) { answer(200); return true; }
    const sent = within(byAddress, to, DAY);
    // asked again the same day: the first one is on its way, and a second would only help someone mail a stranger
    if (sent.length >= DESKTOP_LINK_LIMITS.perAddressDay) { answer(200); return true; }
    const today = new Date(now()).toISOString().slice(0, 10);
    if (day.key !== today) day = { key: today, sent: 0 };
    if (day.sent >= daily) { log(`desktop link: the daily ${daily} is reached, the page offers the mail app instead`); answer(503, "mail_off"); return true; }
    try {
      await options.mailer.send({ to, ...desktopLinkEmail(options.email) });
    } catch (error) {
      log(`desktop link: the email failed (${error instanceof Error ? error.name : "error"})`);
      answer(503, "mail_off");
      return true;
    }
    sent.push(now());
    day.sent++;
    answer(200);
    return true;
  }
  return { handle };
}
