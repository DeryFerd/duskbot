import { afterEach, describe, expect, it, vi } from "vitest";
import { providerPausedAnswer, resetCloudPowerForTests } from "./cloud-power";
import { answerOf } from "../state/api";

afterEach(() => { vi.unstubAllGlobals(); resetCloudPowerForTests(); });

const PAGE = "Sandbox offline: it is paused, and only a sandbox that paused itself for being idle wakes on a visit. Its owner can resume it: the provider CLI resume sbx_1";

describe("the provider's own page for a paused machine", () => {
  it("is told from every answer the home itself gives", async () => {
    expect(await providerPausedAnswer(new Response(PAGE, { status: 503, headers: { "content-type": "text/plain" } }))).toBe(true);
    expect(await providerPausedAnswer(new Response(PAGE, { status: 200 }))).toBe(false);
    expect(await providerPausedAnswer(new Response("asleep", { status: 503, headers: { "x-dusk-cloud-power": "asleep" } }))).toBe(false);
    expect(await providerPausedAnswer(Response.json({ error: "Sandbox offline" }, { status: 503 }))).toBe(false);
    expect(await providerPausedAnswer(new Response("bad gateway", { status: 502 }))).toBe(false);
  });

  it("reaches the page's api calls as the waking error, never with the provider's words", async () => {
    await expect(answerOf(new Response(PAGE, { status: 503, headers: { "content-type": "text/plain" } }))).rejects.toMatchObject({ status: 503, message: "My Cloud is waking up" });
  });
});
