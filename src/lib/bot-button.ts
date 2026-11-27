import type { CSSProperties } from "react";
import { contrastRatio, mixSrgb, relativeLuminance, toneForSurface } from "./color-contrast";
import type { MausColor } from "./mascot";
import { bothSchemes, grokFill, type Scheme } from "./user-bubble-tone";

/** Pressing steps the fill away from its ink. */
const PRESSED_MIX = 0.12;

export const BOT_BUTTON = "bot-button";

export type BotButtonTone = { fill: string; ink: string; hover: string; pressed: string };

/** A bot's own primary button: grok's send button fill for the bot's colour under its light label (dark only on grok's
 * inverted grey button in dark). In one scheme as plain hex, or, with no scheme, as css values that follow the scheme. */
export function botButtonTone(color: MausColor, scheme?: Scheme): BotButtonTone {
  if (!scheme) {
    const light = botButtonTone(color, "light");
    const dark = botButtonTone(color, "dark");
    return {
      fill: bothSchemes(light.fill, dark.fill),
      ink: bothSchemes(light.ink, dark.ink),
      hover: bothSchemes(light.hover, dark.hover),
      pressed: bothSchemes(light.pressed, dark.pressed),
    };
  }
  const { button, hover, buttonInk } = grokFill(color, scheme);
  const away = relativeLuminance(buttonInk) > 0.5 ? "#000000" : "#ffffff";
  // press from whichever of rest and hover holds the label better: grok's dark hover brightens toward the ink
  const base = contrastRatio(buttonInk, hover) >= contrastRatio(buttonInk, button) ? hover : button;
  return { fill: button, ink: buttonInk, hover, pressed: mixSrgb(away, base, PRESSED_MIX) };
}

/** A bot's colour as type on the composer's surface: the send button's own fill, moved only as far as `min` contrast
 * needs. */
export function botCommandText(color: MausColor, min = 3): string {
  return bothSchemes(
    toneForSurface(botButtonTone(color, "light").fill, "#ffffff", min),
    toneForSurface(botButtonTone(color, "dark").fill, "#1f1f1f", min),
  );
}

export function botButtonStyle(color: MausColor): CSSProperties {
  const tone = botButtonTone(color);
  return {
    "--bot-button": tone.fill,
    "--bot-button-ink": tone.ink,
    "--bot-button-hover": tone.hover,
    "--bot-button-pressed": tone.pressed,
  } as CSSProperties;
}

export type BotButton = { className: string; style?: CSSProperties };

/** A primary action that belongs to one bot. `shape` sizes it either way; `plain` is its look when no single bot owns
 * it, as in a room or for a teammate's line. */
export function botButton(color: MausColor | undefined, shape: string, plain: string): BotButton {
  const classes = (look: string) => [shape, look].filter(Boolean).join(" ");
  return color ? { className: classes(BOT_BUTTON), style: botButtonStyle(color) } : { className: classes(plain) };
}
