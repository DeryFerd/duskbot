import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { validateVpsLifecycleState, type VpsLifecycleState } from "./vps-lifecycle.ts";

export function createVpsLifecycleStore(file: string, environmentId: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(environmentId)) throw new Error("Invalid lifecycle workspace identity");
  return {
    load(): VpsLifecycleState | null {
      let fd: number;
      try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      try {
        const stat = fstatSync(fd);
        // Windows has no O_NOFOLLOW, so a link is caught by name there
        if (constants.O_NOFOLLOW === undefined && lstatSync(file).isSymbolicLink()) throw new Error("Unsafe VPS lifecycle state file");
        if (!stat.isFile() || stat.size > 5_000_000 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe VPS lifecycle state file");
        const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
        if (!value || typeof value !== "object" || !("environmentId" in value) || value.environmentId !== environmentId) throw new Error("VPS lifecycle state belongs to another workspace");
        return validateVpsLifecycleState(value);
      } finally { closeSync(fd); }
    },
    save(state: VpsLifecycleState): void {
      const checked = validateVpsLifecycleState(state);
      const text = JSON.stringify({ ...checked, environmentId });
      if (Buffer.byteLength(text) > 5_000_000) throw new Error("VPS lifecycle state exceeds its storage limit");
      writeFileAtomic(file, text, { mode: 0o600 });
    },
  };
}
