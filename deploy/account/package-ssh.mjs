// How the deploy checks reach the VPS that holds the home package: `ssh contabo` (Tailscale) unless
// DUSK_PACKAGE_SSH_HOST names another host or user@host, through DUSK_PACKAGE_SSH_JUMP (ssh -J) when set. Without
// Tailscale: DUSK_PACKAGE_SSH_JUMP=oracle DUSK_PACKAGE_SSH_HOST=root@169.58.211.160.
const SAFE = /^[A-Za-z0-9_][A-Za-z0-9_.@:,-]*$/;

/** ssh's arguments up to the host, from `env`; a value ssh could read as an option is refused */
export function packageSsh(env = process.env) {
  const host = env.DUSK_PACKAGE_SSH_HOST || "contabo", jump = env.DUSK_PACKAGE_SSH_JUMP || "";
  if (!SAFE.test(host)) throw new Error("DUSK_PACKAGE_SSH_HOST is not a host name or user@host");
  if (jump && !SAFE.test(jump)) throw new Error("DUSK_PACKAGE_SSH_JUMP is not a host list for ssh -J");
  return { host, label: jump ? `${host} via ${jump}` : host, args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", ...(jump ? ["-J", jump] : []), host] };
}
