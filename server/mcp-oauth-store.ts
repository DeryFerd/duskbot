// Kept apart from config.json so a pasted or exported config never carries a token; a token never follows its entry to another URL.
// Security: sealed under a key of its own (`<file>.key`, 0600 beside it), like the token and email stores; a plain file
// from before is read once and sealed on the next write.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { decryptBrowserState, encryptBrowserState } from "./browser-sites.ts";

const tokensSchema = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1).optional(),
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
});

const recordSchema = z.object({
  url: z.string(),
  state: z.enum(["needs-sign-in", "signed-in"]),
  issuer: z.string().optional(),
  clientId: z.string().optional(),
  /** The secret stays in config.json; it is never kept here. */
  tokenAuth: z.enum(["client_secret_post", "client_secret_basic"]).optional(),
  redirectUri: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  revocationEndpoint: z.string().optional(),
  tokens: tokensSchema.optional(),
  /** Lent by another place of the person's own, which keeps the refresh token (connector-sync.ts): only an access
   * token here, never refreshed here. `grantAt`: when the holder signed in, so a later sign-out anywhere ends it. */
  lent: z.object({ from: z.string().max(200), grantAt: z.number() }).optional(),
});

const fileSchema = z.object({
  servers: z.record(z.string(), recordSchema).default({}),
});

export type McpOAuthTokens = z.infer<typeof tokensSchema>;
export type McpOAuthRecord = z.infer<typeof recordSchema>;
type StoreFile = z.infer<typeof fileSchema>;

/** One sign-in as this store keeps it, from anywhere else (a sign-in moved from the person's own computer); null if not. */
export function parseMcpOAuthRecord(value: unknown): McpOAuthRecord | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class McpOAuthStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  get(name: string, url: string): McpOAuthRecord | undefined {
    const record = this.read().servers[name];
    return record && record.url === url ? record : undefined;
  }

  put(name: string, record: McpOAuthRecord): void {
    const data = this.read();
    data.servers[name] = recordSchema.parse(record);
    this.write(data);
  }

  delete(name: string): void {
    const data = this.read();
    if (!Object.hasOwn(data.servers, name)) return;
    delete data.servers[name];
    this.write(data);
  }

  private key(create: boolean): string | null {
    try {
      const existing = readFileSync(`${this.file}.key`, "utf8").trim();
      if (/^[0-9a-f]{64}$/u.test(existing)) return existing;
    } catch {}
    if (!create) return null;
    const key = randomBytes(32).toString("hex");
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(`${this.file}.key`, `${key}\n`, { mode: 0o600 });
    return key;
  }

  // Read through on every call: another process may have changed the file.
  private read(): StoreFile {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(fileText(readFileSync(this.file), this.key(false))));
      if (parsed.success) return parsed.data;
    } catch {
    }
    return { servers: {} };
  }

  private write(data: StoreFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, encryptBrowserState(JSON.stringify(data), this.key(true)!), { mode: 0o600 });
  }
}

/** The whole file as JSON, opened with its key: for tests and moves that look at it from outside the store. */
export function openMcpOAuthFile(file: string): { servers: Record<string, any> } {
  let key: string | null = null;
  try { key = readFileSync(`${file}.key`, "utf8").trim(); } catch {}
  return JSON.parse(fileText(readFileSync(file), key));
}

/** The sealed file opened with its key; plain JSON only when it does not open, as an old unsealed file. A sealed file
 * starts with a random nonce, so one in 256 starts with "{" too: the first byte alone cannot tell them apart. */
function fileText(raw: Buffer, key: string | null): string {
  if (key) {
    try {
      return decryptBrowserState(raw, key);
    } catch (error) {
      if (raw[0] !== 0x7b) throw error;
    }
  }
  return raw[0] === 0x7b ? raw.toString("utf8") : "";
}
