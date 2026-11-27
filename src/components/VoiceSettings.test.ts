// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  config: { tts: { configured: true, provider: "elevenlabs", voice: "" } } as Record<string, unknown>,
  platform: "darwin",
}));
vi.mock("@/components/DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { host: { platform: fixture.platform } } }),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: vi.fn() }),
}));

const { VoiceSettings } = await import("./VoiceSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIBRARY = { id: "lib-1", label: "Library Rachel", description: "irish", publicOwnerId: "owner2" };
const bot = (id: string): Bot => ({
  id, threadId: "t", name: id, title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], modelSelection: { instanceId: "codex", model: "m" },
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  document.documentElement.dataset.reducedMotion = "true";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  fixture.api.mockReset();
});

function addLater() {
  let resolve!: (value: { voiceId: string }) => void;
  const added = new Promise<{ voiceId: string }>((done) => (resolve = done));
  fixture.api.mockImplementation((path: string) =>
    path === "/api/tts/voices/add" ? added : Promise.resolve({ voices: [LIBRARY] }));
  return resolve;
}

const render = (forBot: Bot, onPatch: (patch: Record<string, unknown>) => void) =>
  act(async () => root.render(createElement(VoiceSettings, { bot: forBot, onPatch })));
const trigger = () => host.querySelector<HTMLButtonElement>("[data-voice-picker]")!;

async function pickLibraryVoice() {
  await act(async () => trigger().click());
  const row = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("Library Rachel"))!;
  await act(async () => row.click());
}

describe("VoiceSettings", () => {
  it("sets a library voice once ElevenLabs has added it, and says it is adding meanwhile", async () => {
    const resolve = addLater();
    const onPatch = vi.fn();
    await render(bot("pepper"), onPatch);
    await pickLibraryVoice();

    expect(fixture.api).toHaveBeenCalledWith("/api/tts/voices/add", expect.objectContaining({ method: "POST" }));
    expect(trigger().textContent).toContain("Adding…");
    await act(async () => resolve({ voiceId: "added-1" }));
    expect(onPatch).toHaveBeenCalledWith({ voice: "added-1" });
    expect(trigger().disabled).toBe(false);
  });

  it("drops an add that settles after the bot changed, so it never lands on the wrong bot", async () => {
    const resolve = addLater();
    const onPatch = vi.fn();
    await render(bot("pepper"), onPatch);
    await pickLibraryVoice();

    await render(bot("salt"), onPatch);
    expect(trigger().textContent).not.toContain("Adding…");
    await act(async () => resolve({ voiceId: "added-1" }));
    expect(onPatch).not.toHaveBeenCalled();
  });

  const lead = () => host.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
  const others = () => host.querySelector<HTMLSelectElement>('select[aria-label="Use another provider"]')!;
  const keyField = () => host.querySelector('input[type="password"]');

  it("leads with the built-in voice, chosen and with no key field, for a bot with no saved choice", async () => {
    fixture.config = { tts: { configured: true, ready: true, voice: "" } };
    fixture.api.mockResolvedValue({ voices: [] });
    await render(bot("pepper"), vi.fn());
    expect(lead().textContent).toContain("Built-in Mac voices");
    expect(lead().getAttribute("aria-pressed")).toBe("true");
    expect(keyField()).toBeNull();
    expect(host.textContent).not.toContain("belongs to this agent");
  });

  it("keeps a saved provider chosen and shows its key field only then", async () => {
    fixture.config = { tts: { configured: false, provider: "elevenlabs", voice: "" } };
    fixture.api.mockResolvedValue({ voices: [] });
    await render(bot("pepper"), vi.fn());
    expect(lead().getAttribute("aria-pressed")).toBe("false");
    expect(others().value).toBe("elevenlabs");
    expect(keyField()).not.toBeNull();
  });

  it("lists the other eight providers under one calm choice", async () => {
    fixture.config = { tts: { configured: true, provider: "system", voice: "" } };
    fixture.api.mockResolvedValue({ voices: [] });
    await render(bot("pepper"), vi.fn());
    expect([...others().options].map((option) => option.textContent)).toEqual([
      "Use another provider", "ElevenLabs", "Fish Audio", "Grok (xAI)", "Gemini", "OpenAI", "Deepgram", "Cartesia", "Chatterbox (local)",
    ]);
  });

  it("offers no built-in voice where the host has none, and falls back to ElevenLabs", async () => {
    fixture.platform = "linux";
    fixture.config = { tts: { configured: false, voice: "" } };
    fixture.api.mockResolvedValue({ voices: [] });
    await render(bot("pepper"), vi.fn());
    fixture.platform = "darwin";
    expect(host.querySelector("button[aria-pressed]")).toBeNull();
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Voice provider"]')?.value).toBe("elevenlabs");
  });

  it("saves the provider picked under the other-providers choice", async () => {
    fixture.config = { tts: { configured: true, provider: "system", voice: "" } };
    fixture.api.mockResolvedValue({ voices: [] });
    await render(bot("pepper"), vi.fn());
    const select = others();
    await act(async () => {
      select.value = "fish";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ tts: { provider: "fish" } }) });
  });
});
