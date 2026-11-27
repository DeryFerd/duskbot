import { transcribeClip } from "../../electron/voice-providers.mjs";
import type { AppConfig } from "../config.ts";
import { voiceCredential } from "../included-services.ts";
import * as cartesia from "./cartesia.ts";
import * as fish from "./fish.ts";

export type ListenProvider = "fish" | "deepgram" | "elevenlabs" | "openai" | "groq" | "cartesia" | "assemblyai";

export const LISTEN_NAMES: Readonly<Record<ListenProvider, string>> = {
  fish: "Fish Audio", deepgram: "Deepgram", elevenlabs: "ElevenLabs", openai: "OpenAI", groq: "Groq", cartesia: "Cartesia", assemblyai: "AssemblyAI",
};

interface Listener { provider: ListenProvider; key: string }

const text = (value: string | undefined) => value?.trim() || "";

/** The first connected key that can hear, fastest dedicated speech services first; AssemblyAI polls, so it comes last. */
export function listener(cfg: AppConfig): Listener | null {
  const eleven = voiceCredential(cfg.tts?.key);
  const candidates: Array<[ListenProvider, string]> = [
    ["fish", text(cfg.tts?.fishKey)],
    ["deepgram", text(cfg.tts?.deepgramKey)],
    // the included Cloud Pro voice goes only to its relay, which does not transcribe
    ["elevenlabs", eleven && !eleven.included ? eleven.token : ""],
    ["openai", text(cfg.openai?.key)],
    ["groq", text(cfg.groq?.key)],
    ["cartesia", text(cfg.tts?.cartesiaKey)],
    ["assemblyai", text(cfg.tts?.assemblyAiKey)],
  ];
  const found = candidates.find(([, key]) => key);
  return found ? { provider: found[0], key: found[1] } : null;
}

/** Never includes the key. */
export function describeListen(cfg: AppConfig): { ready: boolean; provider?: string } {
  const found = listener(cfg);
  return found ? { ready: true, provider: LISTEN_NAMES[found.provider] } : { ready: false };
}

/** `language` is a BCP 47 tag the person speaks; without one the service detects it. */
export async function transcribe(found: Listener, audio: Uint8Array, mime: string, language?: string): Promise<string> {
  if (found.provider === "fish") return fish.transcribe(audio, mime, found.key);
  if (found.provider === "cartesia") return cartesia.transcribe(audio, mime, found.key);
  return transcribeClip({ provider: found.provider, wav: audio, key: found.key, language, signal: AbortSignal.timeout(90_000) });
}
