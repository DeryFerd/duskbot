import type { AppConfig } from "../config.ts";
import { voiceCredential } from "../included-services.ts";
import * as cartesia from "./cartesia.ts";
import * as assemblyai from "./assemblyai.ts";
import * as chatterbox from "./chatterbox.ts";
import * as deepgram from "./deepgram.ts";
import * as elevenlabs from "./elevenlabs.ts";
import * as grok from "./grok.ts";
import * as fish from "./fish.ts";
import * as gemini from "./gemini.ts";
import { describeListen } from "./listen.ts";
import * as openai from "./openai.ts";
import * as systemVoices from "./system-voices.ts";

export type VoiceProvider = "elevenlabs" | "fish" | "system" | "chatterbox" | "xai" | "gemini" | "openai" | "deepgram" | "cartesia";

const OTHER_PROVIDERS: readonly VoiceProvider[] = ["gemini", "xai", "fish", "system", "chatterbox", "openai", "deepgram", "cartesia"];

function keyFor(cfg: AppConfig, provider: VoiceProvider): string | undefined {
  if (provider === "openai") return cfg.openai?.key?.trim() || undefined;
  if (provider === "deepgram") return cfg.tts?.deepgramKey?.trim() || undefined;
  if (provider === "cartesia") return cfg.tts?.cartesiaKey?.trim() || undefined;
  return undefined;
}

const KEYED_VOICES = {
  openai: { module: openai, name: "OpenAI", hint: "Add an OpenAI key in Settings to use OpenAI voice." },
  deepgram: { module: deepgram, name: "Deepgram", hint: "Add a Deepgram key in Settings to use Deepgram voice." },
  cartesia: { module: cartesia, name: "Cartesia", hint: "Add a Cartesia key in Settings to use Cartesia voice." },
} as const;

const isKeyedVoice = (provider: VoiceProvider): provider is keyof typeof KEYED_VOICES => Object.hasOwn(KEYED_VOICES, provider);

export class NoVoiceConfigured extends Error {
  // Not a parameter property: the harness runs under strip-only `node --experimental-strip-types`, which rejects one at load.
  readonly reason: "key" | "voice";

  constructor(reason: "key" | "voice", hint?: string) {
    super(
      hint ??
        (reason === "key"
          ? "Add an ElevenLabs key in Settings on the computer to turn on voice."
          : "Pick a voice in the agent profile."),
    );
    this.reason = reason;
  }
}

const elevenLabs = (cfg: AppConfig) => voiceCredential(cfg.tts?.key);

/** An explicit choice always wins. With none, an ElevenLabs credential already on file (own key, env or included) keeps
 * ElevenLabs; otherwise the OS voice, where this host has one. A host without it falls back to ElevenLabs, the only
 * engine that can be included with the plan. */
export function voiceProvider(cfg: AppConfig, platform: string = process.platform): VoiceProvider {
  const provider = cfg.tts?.provider;
  if (provider === "elevenlabs") return provider;
  if (provider && OTHER_PROVIDERS.includes(provider)) return provider;
  if (elevenLabs(cfg)) return "elevenlabs";
  return systemVoices.systemVoicesAvailable(platform) ? "system" : "elevenlabs";
}

export function providerConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (isKeyedVoice(provider)) return Boolean(keyFor(cfg, provider));
  if (provider === "gemini") return Boolean(cfg.tts?.geminiKey);
  if (provider === "xai") return Boolean(cfg.xai?.key);
  if (provider === "system") return systemVoices.systemVoicesAvailable();
  if (provider === "chatterbox") return Boolean(cfg.tts?.baseUrl?.trim());
  if (provider === "fish") return Boolean(cfg.tts?.fishKey);
  return Boolean(elevenLabs(cfg));
}

export function voiceConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (isKeyedVoice(provider)) return Boolean(keyFor(cfg, provider) && KEYED_VOICES[provider].module.isSupportedVoice(cfg.tts?.voice));
  if (provider === "gemini") return Boolean(cfg.tts?.geminiKey && gemini.isSupportedVoice(cfg.tts?.voice));
  if (provider === "xai") return Boolean(cfg.xai?.key && cfg.tts?.voice);
  if (provider === "system") return systemVoices.systemVoicesAvailable();
  if (provider === "chatterbox") return Boolean(cfg.tts?.baseUrl?.trim() && cfg.tts?.voice);
  if (provider === "fish") return Boolean(cfg.tts?.fishKey && cfg.tts?.voice);
  return Boolean(elevenLabs(cfg) && cfg.tts?.voice);
}

export function voiceReady(cfg: AppConfig, voiceId?: string): boolean {
  const provider = voiceProvider(cfg);
  if (isKeyedVoice(provider)) return Boolean(keyFor(cfg, provider) && KEYED_VOICES[provider].module.isSupportedVoice(voiceId || cfg.tts?.voice));
  if (provider === "gemini") return Boolean(cfg.tts?.geminiKey && gemini.isSupportedVoice(voiceId || cfg.tts?.voice));
  if (provider === "xai") return Boolean(cfg.xai?.key && (voiceId || cfg.tts?.voice));
  if (provider === "system") return systemVoices.systemVoicesAvailable();
  if (provider === "chatterbox") return Boolean(cfg.tts?.baseUrl?.trim() && (voiceId || cfg.tts?.voice));
  if (provider === "fish") return Boolean(cfg.tts?.fishKey && (voiceId || cfg.tts?.voice));
  return Boolean(elevenLabs(cfg) && (voiceId || cfg.tts?.voice));
}

/** Never includes the key. */
export function describeVoice(cfg: AppConfig) {
  const provider = voiceProvider(cfg);
  const included = provider === "elevenlabs" && elevenLabs(cfg)?.included === true;
  return {
    configured: providerConfigured(cfg),
    ready: voiceConfigured(cfg),
    voice: cfg.tts?.voice ?? "",
    provider,
    baseUrl: provider === "chatterbox" ? (cfg.tts?.baseUrl ?? "") : "",
    model: provider === "gemini" ? (cfg.tts?.model || gemini.DEFAULT_GEMINI_MODEL) : provider === "chatterbox" ? (cfg.tts?.model ?? "") : "",
    ...(provider === "fish" ? { fishModel: cfg.tts?.fishModel ?? fish.DEFAULT_FISH_MODEL } : {}),
    ...(included ? { included: true as const } : {}),
    listen: describeListen(cfg),
  };
}

export type VerifiedVoiceKey = "elevenlabs" | "fish" | "deepgram" | "cartesia" | "assemblyai";

export function verifyKey(provider: VerifiedVoiceKey, key: string) {
  if (provider === "fish") return fish.verifyKey(key);
  if (provider === "deepgram") return deepgram.verifyKey(key);
  if (provider === "cartesia") return cartesia.verifyKey(key);
  if (provider === "assemblyai") return assemblyai.verifyKey(key);
  return elevenlabs.verifyKey(key);
}

export async function listVoices(
  cfg: AppConfig,
  run?: systemVoices.Runner,
  search?: fish.VoiceSearch,
): Promise<elevenlabs.Voice[]> {
  const provider = voiceProvider(cfg);
  if (provider === "openai") return keyFor(cfg, provider) ? openai.listVoices() : [];
  if (provider === "deepgram") return keyFor(cfg, provider) ? deepgram.listVoices() : [];
  if (provider === "cartesia") {
    const key = keyFor(cfg, provider);
    return key ? cartesia.listVoices(key, search) : [];
  }
  if (provider === "gemini") return cfg.tts?.geminiKey ? gemini.listVoices() : [];
  if (provider === "xai") return cfg.xai?.key ? grok.listVoices(cfg.xai.key) : [];
  if (provider === "system") return systemVoices.listSystemVoices(run);
  if (provider === "chatterbox") {
    const baseUrl = cfg.tts?.baseUrl?.trim();
    return baseUrl ? chatterbox.listChatterboxVoices(baseUrl) : [];
  }
  if (provider === "fish") {
    const key = cfg.tts?.fishKey;
    return key ? fish.listVoices(key, search) : [];
  }
  const credential = elevenLabs(cfg);
  if (!credential) return [];
  return elevenlabs.listVoices(credential.token, credential.api, search);
}

export async function addSharedVoice(cfg: AppConfig, publicOwnerId: string, voiceId: string, name: string): Promise<string> {
  const credential = voiceProvider(cfg) === "elevenlabs" ? elevenLabs(cfg) : null;
  if (!credential) throw new NoVoiceConfigured("key");
  return elevenlabs.addSharedVoice(credential.token, credential.api, publicOwnerId, voiceId, name);
}

export function speak(cfg: AppConfig, text: string, voiceId?: string, run?: systemVoices.Runner) {
  const provider = voiceProvider(cfg);
  if (isKeyedVoice(provider)) {
    const key = keyFor(cfg, provider);
    if (!key) throw new NoVoiceConfigured("key", KEYED_VOICES[provider].hint);
    const voice = voiceId || cfg.tts?.voice;
    if (!voice) throw new NoVoiceConfigured("voice");
    return KEYED_VOICES[provider].module.synthesize(text, voice, key);
  }
  if (provider === "gemini") {
    const key = cfg.tts?.geminiKey;
    if (!key) throw new NoVoiceConfigured("key", "Add a Gemini API key in Settings to use Gemini voice.");
    const voice = voiceId || cfg.tts?.voice;
    if (!voice) throw new NoVoiceConfigured("voice");
    return gemini.synthesize(text, voice, key, cfg.tts?.model);
  }
  if (provider === "xai") {
    const key = cfg.xai?.key;
    if (!key) throw new NoVoiceConfigured("key", "Add an xAI key in Settings to use Grok voice.");
    const voice = voiceId || cfg.tts?.voice;
    if (!voice) throw new NoVoiceConfigured("voice");
    return grok.synthesize(text, voice, key);
  }
  if (provider === "system") {
    if (!systemVoices.systemVoicesAvailable() && !run) throw new NoVoiceConfigured("key");
    return systemVoices.synthesizeSystem(text, voiceId || cfg.tts?.voice, run);
  }
  if (provider === "chatterbox") {
    const baseUrl = cfg.tts?.baseUrl?.trim();
    if (!baseUrl) {
      throw new NoVoiceConfigured(
        "key",
        "Add the address of your Chatterbox server in Settings on the computer to turn on voice.",
      );
    }
    const voice = voiceId || cfg.tts?.voice;
    if (!voice) throw new NoVoiceConfigured("voice");
    return chatterbox.synthesizeChatterbox(text, voice, baseUrl, cfg.tts?.model);
  }
  if (provider === "fish") {
    const key = cfg.tts?.fishKey;
    if (!key) {
      throw new NoVoiceConfigured(
        "key",
        "Add a Fish Audio key in Settings on the computer to turn on voice.",
      );
    }
    const voice = voiceId || cfg.tts?.voice;
    if (!voice) throw new NoVoiceConfigured("voice");
    return fish.synthesize(text, voice, key, cfg.tts?.fishModel);
  }
  const credential = elevenLabs(cfg);
  if (!credential) throw new NoVoiceConfigured("key");
  const voice = voiceId || cfg.tts?.voice;
  if (!voice) throw new NoVoiceConfigured("voice");
  return elevenlabs.synthesize(text, voice, credential.token, credential.api).audio;
}

export type { Voice } from "./elevenlabs.ts";
