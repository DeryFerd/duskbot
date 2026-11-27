// Codex's device-code sign-in: `codex login --device-auth`, `codex login status` to keep and confirm a login, `codex logout`.
import { stripVTControlCharacters } from "node:util";
import { deviceSignInPrompt } from "../../shared/device-sign-in.ts";
import { DeviceAuthController, type DeviceAuthOptions, type DeviceSignIn } from "./device-auth.ts";
import { codexReportsLogin } from "./codex-login.ts";

export function codexDevicePrompt(output: string): { authorizationUrl: string; userCode?: string } | null {
  return deviceSignInPrompt("codex", stripVTControlCharacters(output));
}

/** codex-cli 0.170: "device auth failed with status <N>" when OpenAI answers a token poll with anything but success,
 * 403 or 404 (still waiting), "device code exchange failed: …" after approval, "failed to request device code: …" before
 * a code, and "device code request failed with status <N>". */
export function codexLoginFailureKind(output: string): { kind: string; status?: number } {
  const status = Number(/\bstatus (\d{3})\b/i.exec(output)?.[1]) || undefined;
  const kind = /unexpected argument|unrecognized (argument|option)|unknown option/i.test(output) ? "cli_outdated"
    : /device.{0,40}(disabled|not enabled|not allowed)|enable.{0,40}device/i.test(output) ? "device_code_disabled"
      : /device auth failed with status/i.test(output) ? "device_auth_refused"
        : /device code exchange failed/i.test(output) ? "token_exchange_failed"
          : /device code request failed|failed to request device code/i.test(output) ? "code_request_failed"
            : /expired|expiration|timed out/i.test(output) ? "expired"
              : "other";
  return status ? { kind, status } : { kind };
}

function loginFailure(output: string): string {
  if (/(unexpected argument|unrecognized (argument|option)|unknown option).*device-auth/i.test(output)) {
    return "This server's Codex CLI needs updating for browser sign-in. Run npm install -g @openai/codex@latest on the server, then try again.";
  }
  if (/device.{0,40}(disabled|not enabled|not allowed)|enable.{0,40}device/i.test(output)) {
    return "Enable device-code login in your ChatGPT security settings or ask your workspace admin to allow it, then try again.";
  }
  if (/expired|expiration|timed out/i.test(output)) {
    return "The ChatGPT sign-in code expired. Start sign-in again for a new code.";
  }
  const { status } = codexLoginFailureKind(output);
  if (status === 429) return "OpenAI got too many requests for this sign-in. Wait a minute, then try again.";
  if (status && status >= 500) return "OpenAI's sign-in is temporarily unavailable. Try again in a minute.";
  return "ChatGPT sign-in did not finish. Check the server's connection and that device-code login is enabled in ChatGPT, then try again.";
}

export const CODEX_DEVICE_SIGN_IN: DeviceSignIn = {
  provider: "codex",
  product: "Codex",
  account: "ChatGPT",
  homeEnv: "CODEX_HOME",
  homeDir: ".codex",
  loginArgs: ["login", "--device-auth"],
  install: "Run npm install -g @openai/codex@latest on the server, then try again.",
  failure: loginFailure,
  failureKind: codexLoginFailureKind,
  status: {
    args: ["login", "status"],
    read: (code, output) =>
      code === 0 && /^logged in.*chatgpt\b/im.test(output) ? "signed-in"
      : code === 0 && codexReportsLogin(output) ? "other"
      : code !== 0 && /^not logged in\b/im.test(output) ? "signed-out"
      : "unknown",
  },
  logoutArgs: ["logout"],
  // codex-cli 0.167: `codex login` serves http://localhost:1455/auth/callback and prints the auth.openai.com link
  browserLogin: { args: ["login"], env: { BROWSER: "true" }, page: /^auth\.openai\.com$/ },
};

export class CodexDeviceAuthController extends DeviceAuthController {
  constructor(options: DeviceAuthOptions) { super(CODEX_DEVICE_SIGN_IN, options); }
}
