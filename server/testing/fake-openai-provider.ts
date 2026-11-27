// An OpenAI-compatible chat-completions server for tests, on a real socket: each request to /chat/completions is
// answered by `reply`, which sees the parsed body and the request's number. `routeFetch` sends a provider's own address
// (https://generativelanguage.googleapis.com/...) here, so address-based provider rules still apply.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeProviderRequest { body: Record<string, any>; n: number; path: string }
export type FakeProviderReply =
  | { status: number; json: unknown; headers?: Record<string, string> }
  | { stream: string[]; delayMs?: number }
  | { hang: true }
  | { destroy: true };

export interface FakeOpenAIProvider {
  origin: string;
  requests: FakeProviderRequest[];
  routeFetch(from: string): typeof fetch;
  close(): Promise<void>;
}

export const sseText = (text: string): string[] => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

export async function startFakeOpenAIProvider(reply: (request: FakeProviderRequest) => FakeProviderReply): Promise<FakeOpenAIProvider> {
  const requests: FakeProviderRequest[] = [];
  const open = new Set<ServerResponse>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      if (!path.endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
        return;
      }
      const request = { body: raw ? JSON.parse(raw) : {}, n: requests.length + 1, path };
      requests.push(request);
      const answer = reply(request);
      if ("destroy" in answer) { req.socket.destroy(); return; }
      if ("hang" in answer) { open.add(res); return; }
      if ("json" in answer) {
        res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers }).end(JSON.stringify(answer.json));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let at = 0;
      const next = () => {
        if (at >= answer.stream.length) { res.end(); return; }
        res.write(answer.stream[at++]);
        setTimeout(next, answer.delayMs ?? 0);
      };
      next();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  return {
    origin,
    requests,
    routeFetch: (from) => ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return realFetch(url.startsWith(from) ? origin + new URL(url).pathname : url, init);
    }) as typeof fetch,
    close: () => new Promise<void>((resolve) => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
