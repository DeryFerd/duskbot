import type { RailPlace } from "../../electron/cloud-rail.mjs";
import { Laptop, UserRound } from "../icons";
import { cn } from "@/lib/cn";
import { cloudColor, cloudColorFill } from "@/lib/cloud-look";
import { placeInitials } from "@/lib/places";

/** A place's mark at any size: a rounded square, its corners in step with its size. */
const tileRadius = (size: number) => Math.round(size * 0.3);

/** What a place's mark draws: its kind, its name's letters and its colour, faded while it is offline or has ended. */
type MarkedPlace = Pick<RailPlace, "kind" | "name" | "offline" | "ended"> & { color: unknown };

export function PlaceMark({ place, size = 24 }: { place: MarkedPlace; size?: number }) {
  const color = cloudColor(place.color);
  return <span aria-hidden="true" data-rail-offline={place.offline ? "" : undefined} data-rail-ended={place.ended ? "" : undefined}
    className={cn("grid shrink-0 place-items-center font-semibold leading-none", color ? "text-white" : "bg-card text-ink", (place.offline || place.ended) && "opacity-55 grayscale")}
    style={{ width: size, height: size, borderRadius: tileRadius(size), fontSize: Math.round(size * 0.4), ...(color ? { background: cloudColorFill(color) } : {}) }}>
    {place.kind === "computer" ? <Laptop size={Math.round(size * 0.46)} strokeWidth={1.75} /> : place.kind === "account" ? <UserRound size={Math.round(size * 0.5)} strokeWidth={1.75} /> : placeInitials(place.name)}
  </span>;
}
