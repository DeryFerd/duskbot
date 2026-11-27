// The bot's AI endpoint with a usage limit: until a moment on the simulated clock, every model call is refused the way a
// plan's limit refuses it (429 and the reset time in words); after it, calls pass to the gateway unchanged.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface LimitProxy { url: string; refused: () => number; close: () => Promise<void> }

export async function startLimitProxy(target: string, until: () => boolean, message: string): Promise<LimitProxy> {
  let refused = 0;
  const base = new URL(target);
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.method === "POST" && until()) {
      refused += 1;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message, type: "usage_limit_reached", code: "usage_limit_reached" } }));
      return;
    }
    try {
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "content-length", "connection"].includes(k)).map(([k, v]) => [k, String(v)]));
      const upstream = await fetch(`${base.origin}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
      res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding"].includes(k))));
      if (upstream.body) for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(502);
      res.end(String((error as Error).message));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}${base.pathname.replace(/\/+$/, "")}`, refused: () => refused, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}
