export interface AuthenticateRetryPolicy {
  displayName: string;
  loginNote: string;
  authFailure: "fail" | "fail-request" | "continue";
  authenticateRetry?(error: unknown): "momentary" | "unconfirmed" | undefined;
  authenticateRetryDelaysMs?: readonly number[];
  momentaryAuthNote?: string;
}

/** Runs `authenticate`, trying again after each configured delay while the failure may be momentary. Returns whether it
 * succeeded; throws the plain note a turn shows when it did not (the sign-in note, or the momentary one when only
 * network-like failures were seen), and returns false for engines that continue on an ambient login. */
export async function authenticateWithRetry(
  policy: AuthenticateRetryPolicy,
  attempt: () => Promise<unknown>,
  stillRunning: () => void,
): Promise<boolean> {
  const delays = policy.authenticateRetryDelaysMs ?? [];
  for (let tries = 0; ; tries++) {
    try {
      await attempt();
      return true;
    } catch (error) {
      const kind = policy.authenticateRetry?.(error);
      if (kind && tries < delays.length) {
        await new Promise((resolveWait) => setTimeout(resolveWait, delays[tries]));
        stillRunning();
        continue;
      }
      if (policy.authFailure === "continue") return false;
      console.warn(`${policy.displayName}: sign-in check failed (${kind ?? "refused"}): ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(kind === "momentary" && policy.momentaryAuthNote ? policy.momentaryAuthNote : policy.loginNote);
    }
  }
}
