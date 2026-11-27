import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";

import { harnessMcpRequest } from "./harness-mcp-request.ts";

let server: Server | undefined;
afterEach(async () => { await new Promise((done) => (server ? server.close(() => done(undefined)) : done(undefined))); server = undefined; });

it("tells a bot whose browser is still starting to call it again, not to look for another computer", async () => {
  server = createServer((_req, res) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Getting the browser ready. Try again in a moment." })); });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const reply = await harnessMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_browser_open", arguments: { url: "https://en.wikipedia.org" } } },
    { url: `http://127.0.0.1:${port}/`, token: "t", kind: "browser" }) as { result: { isError: boolean; content: Array<{ text: string }> } };
  const text = reply.result.content[0]!.text;
  expect(reply.result.isError).toBe(true);
  expect(text).toContain("Getting the browser ready. Try again in a moment.");
  expect(text).toContain("make the same call again in a moment");
  expect(text).not.toContain("select_computer");
});
