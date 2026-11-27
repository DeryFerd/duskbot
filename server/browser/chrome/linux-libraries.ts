// Chrome's Linux system libraries, for hosts where `agent-browser install --with-deps` installs none: on Linux ARM64 it
// exits before reaching them. The package lists follow agent-browser 0.37's (Apache 2.0); unzip unpacks dusk bot's download.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** apt names, with the t64 name Ubuntu 24.04 and Debian 13 renamed some to. */
export const APT_PACKAGES: ReadonlyArray<readonly [string, string?]> = [
  ["libxcb-shm0"], ["libx11-xcb1"], ["libx11-6"], ["libxcb1"], ["libxext6"], ["libxrandr2"], ["libxcomposite1"], ["libxcursor1"],
  ["libxdamage1"], ["libxfixes3"], ["libxi6"], ["libgtk-3-0", "libgtk-3-0t64"], ["libpangocairo-1.0-0", "libpangocairo-1.0-0t64"],
  ["libpango-1.0-0", "libpango-1.0-0t64"], ["libatk1.0-0", "libatk1.0-0t64"], ["libcairo-gobject2", "libcairo-gobject2t64"],
  ["libcairo2", "libcairo2t64"], ["libgdk-pixbuf-2.0-0", "libgdk-pixbuf-2.0-0t64"], ["libxrender1"], ["libasound2", "libasound2t64"],
  ["libfreetype6"], ["libfontconfig1"], ["libdbus-1-3", "libdbus-1-3t64"], ["libnss3"], ["libnss3-tools"], ["libnspr4"],
  ["libatk-bridge2.0-0", "libatk-bridge2.0-0t64"], ["libdrm2"], ["libxkbcommon0"], ["libatspi2.0-0", "libatspi2.0-0t64"],
  ["libcups2", "libcups2t64"], ["libxshmfence1"], ["libgbm1"], ["fonts-noto-color-emoji"], ["fonts-noto-cjk"], ["fonts-freefont-ttf"],
  ["unzip"],
];

export const DNF_PACKAGES = [
  "nss", "nss-tools", "nspr", "atk", "at-spi2-atk", "cups-libs", "libdrm", "libXcomposite", "libXdamage", "libXrandr", "mesa-libgbm",
  "pango", "alsa-lib", "libxkbcommon", "libxcb", "libX11-xcb", "libX11", "libXext", "libXcursor", "libXfixes", "libXi", "gtk3",
  "cairo-gobject", "google-noto-cjk-fonts", "google-noto-emoji-color-fonts", "liberation-fonts", "unzip",
];

export const YUM_PACKAGES = [
  "nss", "nss-tools", "nspr", "atk", "at-spi2-atk", "cups-libs", "libdrm", "libXcomposite", "libXdamage", "libXrandr", "mesa-libgbm",
  "pango", "alsa-lib", "libxkbcommon", "google-noto-cjk-fonts", "liberation-fonts", "unzip",
];

export interface LibraryInstallDeps {
  isRoot: boolean;
  has(command: string): boolean;
  /** `show` lets the package manager's own output (and a sudo password prompt) reach the terminal. */
  run(command: string, args: readonly string[], options?: { show?: boolean }): Promise<{ code: number; output: string }>;
  log(line: string): void;
}

/** Installs the libraries with apt-get, dnf or yum, as root or through sudo; throws with what to run by hand when it cannot. */
export async function installChromeLibraries(deps: LibraryInstallDeps): Promise<void> {
  const elevated = (command: string, args: readonly string[]): [string, string[]] => deps.isRoot ? [command, [...args]] : ["sudo", [command, ...args]];
  const run = (command: string, args: readonly string[], show = false) => deps.run(...elevated(command, args), { show });
  if (deps.has("apt-get")) {
    deps.log("installing Chrome's system libraries with apt-get");
    if ((await run("apt-get", ["update"], true)).code !== 0) deps.log("apt-get update failed; continuing with the package lists already here");
    const packages: string[] = [];
    for (const [name, t64] of APT_PACKAGES) packages.push(t64 && (await deps.run("apt-cache", ["show", t64])).code === 0 ? t64 : name);
    const byHand = `sudo apt-get install ${packages.join(" ")}`;
    // apt can resolve a rename by removing packages; nothing is installed when it would remove any
    const simulated = await run("apt-get", ["install", "--simulate", ...packages]);
    if (simulated.code !== 0) throw new Error(`apt could not install Chrome's libraries; to see why, run: ${byHand}`);
    const removals = simulated.output.split("\n").filter((line) => line.startsWith("Remv ")).length;
    if (removals) throw new Error(`apt would remove ${removals} package(s) to install Chrome's libraries, so nothing was installed; review it by hand: ${byHand}`);
    if ((await run("apt-get", ["install", "-y", ...packages], true)).code !== 0) throw new Error(`apt-get could not install Chrome's libraries; try: ${byHand}`);
  } else {
    const manager = ["dnf", "yum"].find((name) => deps.has(name));
    if (!manager) throw new Error("no supported package manager here (apt-get, dnf or yum): install Chrome's libraries and unzip with this system's own");
    const packages = manager === "dnf" ? DNF_PACKAGES : YUM_PACKAGES;
    deps.log(`installing Chrome's system libraries with ${manager}`);
    if ((await run(manager, ["install", "-y", ...packages], true)).code !== 0) throw new Error(`${manager} could not install Chrome's libraries; try: sudo ${manager} install ${packages.join(" ")}`);
  }
  deps.log("Chrome's system libraries are installed");
}

export function commandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PATH ?? "").split(delimiter).filter(Boolean).some((directory) => {
    try { accessSync(join(directory, command), constants.X_OK); return true; } catch { return false; }
  });
}

export function hostLibraryInstall(log: (line: string) => void, env: NodeJS.ProcessEnv = process.env): LibraryInstallDeps {
  return {
    isRoot: process.getuid?.() === 0,
    has: (command) => commandOnPath(command, env),
    run: (command, args, options) => new Promise((done) => {
      let output = "";
      const child = spawn(command, [...args], { env: { ...env, DEBIAN_FRONTEND: "noninteractive" }, stdio: options?.show ? "inherit" : ["ignore", "pipe", "pipe"] });
      const record = (chunk: Buffer) => { if (output.length < 1_048_576) output += String(chunk); };
      child.stdout?.on("data", record);
      child.stderr?.on("data", record);
      child.on("error", (error) => done({ code: 127, output: error.message }));
      child.on("close", (code) => done({ code: code ?? 1, output }));
    }),
    log,
  };
}
