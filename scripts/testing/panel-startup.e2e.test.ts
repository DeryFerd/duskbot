import { writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlDusk } from "../control-dusk.ts";
import { closeBrowserSession } from "../../server/browser-engine.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-dusk-ui.ts";
import { mountPreview } from "./preview-fixture.ts";

// a real Chrome needs the sandbox the renderer smoke job sets up (Ubuntu 24.04 blocks it elsewhere), so it runs there
const enabled = process.env.DUSK_UI_E2E === "1";
if (!enabled) console.log("skipping panel startup: set DUSK_UI_E2E=1 to run it in an isolated browser");

it.skipIf(!enabled)("paints the saved panel mascot with the first chat while engine and computer status remain pending", async () => {
  const tools = await ensureUiBrowser();
  const fixture = await launchVerificationServer({}, undefined, undefined, { binaryPath: tools.binary, executablePath: tools.chrome ?? "" });
  const held = new Set<ServerResponse>();
  let engineReads = 0, computerReads = 0, controlWrites = 0;
  let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
  let env: ReturnType<typeof sessionEnv> | undefined;
  try {
    await runControlDusk(["new-bot", "--name", "Pepper", "--url", fixture.info.url]);
    preview = await mountPreview(fixture, { entry: "/scripts/testing/panel-startup-preview.tsx", route: "/__panel-startup.html", title: "Isolated panel startup", logLevel: "error", hmr: false, extraRoutes: [
      { path: "/api/instances", method: "GET", handler: (_req, res) => { engineReads++; held.add(res); res.once("close", () => held.delete(res)); } },
      { path: /^\/api\/bots\/[^/]+\/computer$/, method: "GET", handler: (_req, res) => { computerReads++; held.add(res); res.once("close", () => held.delete(res)); } },
      { path: /^\/api\/bots\/[^/]+\/computer\/(?:control|power|start)$/, method: "POST", handler: (_req, res) => { controlWrites++; res.writeHead(409).end(); } },
    ] });
    env = sessionEnv({ home: fixture.info.dataDir, session: `ps-${fixture.info.pid}`, chrome: tools.chrome });
    const browser = (args: string[], timeout?: number) => agentBrowser(tools.binary, env!, args, timeout);
    await browser(["open", preview.previewUrl], 120_000);
    const until = async (expression: string) => {
      const end = Date.now() + 15_000;
      for (;;) {
        const value = await browser(["eval", expression]);
        if (value.result) return value.result;
        if (Date.now() > end) throw new Error("panel startup predicate timed out");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const probe = await until("window.__panelStartupProbe?.firstChatAt !== null && window.__panelStartupProbe") as { firstChatAt: number; panelAtFirstChat: boolean; mascotAtFirstChat: boolean };
    expect(probe.panelAtFirstChat).toBe(true);
    expect(probe.mascotAtFirstChat).toBe(true);
    expect(engineReads).toBeGreaterThan(0);
    // the boot cover closes its ring and fades once the first chat paints; a click waits for it like a person does
    await until("!document.querySelector('[data-boot-cover]:not([data-boot-cover=fading])')");
    await browser(["click", '[data-panel-tab="computer"]']);
    await until("Boolean(document.querySelector('[data-panel-screen] [data-asleep-mascot]'))");
    await until("Boolean(document.querySelector('[data-inline-computer]'))");
    expect(computerReads).toBeGreaterThan(0);
    expect(held.size).toBeGreaterThan(0);
    expect(controlWrites).toBe(0);
    const evidence = { fixture: fixture.info, firstChat: probe, pendingEngineReads: engineReads, pendingComputerReads: computerReads, controlWrites };
    writeFileSync(`${fixture.info.logPath}.panel-startup.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  } finally {
    if (env) await closeBrowserSession(tools.binary, env);
    for (const response of held) response.destroy();
    await preview?.close();
    await fixture.close();
  }
}, 120_000);
