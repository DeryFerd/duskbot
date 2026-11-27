const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const tag = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && TAG.test(trimmed) ? trimmed : undefined;
};

/** The bot's own call language, else Settings > Voice's language, else the app's language, else the computer's. */
export function callLanguage(where: { bot?: string; voiceInput?: string; app?: string | null; device?: string | null }): string {
  return tag(where.bot) ?? tag(where.voiceInput) ?? tag(where.app) ?? tag(where.device) ?? "en";
}

/** Moonshine base hears only English and Kokoro speaks through an English lexicon. */
export function builtInVoiceKnows(language: string | undefined): boolean {
  return !language || language.split("-")[0]!.toLowerCase() === "en";
}
