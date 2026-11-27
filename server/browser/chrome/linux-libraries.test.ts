import { describe, expect, it } from "vitest";

import { APT_PACKAGES, installChromeLibraries, type LibraryInstallDeps } from "./linux-libraries.ts";

function fakeHost(options: { root?: boolean; managers?: string[]; t64?: string[]; simulate?: { code: number; output: string }; failInstall?: boolean } = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const deps: LibraryInstallDeps = {
    isRoot: options.root ?? true,
    has: (command) => (options.managers ?? ["apt-get"]).includes(command),
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      const words = command === "sudo" ? args.slice(1) : args;
      if (command === "apt-cache") return { code: options.t64?.includes(args[1]!) ? 0 : 100, output: "" };
      if (words.includes("--simulate")) return options.simulate ?? { code: 0, output: "Inst libnss3\n" };
      if (words[0] === "install") return { code: options.failInstall ? 100 : 0, output: "" };
      return { code: 0, output: "" };
    },
    log: (line) => lines.push(line),
  };
  return { deps, calls, lines };
}

describe("Chrome's Linux libraries, installed by dusk bot where agent-browser installs none", () => {
  it("picks Ubuntu 24.04's t64 names where they exist and installs unzip too", async () => {
    const host = fakeHost({ t64: ["libasound2t64", "libgtk-3-0t64"] });
    await installChromeLibraries(host.deps);
    const install = host.calls.find((call) => call.startsWith("apt-get install -y "))!;
    expect(host.calls[0]).toBe("apt-get update");
    expect(install.split(" ")).toEqual(expect.arrayContaining(["libasound2t64", "libgtk-3-0t64", "libnss3", "unzip"]));
    expect(install.split(" ")).not.toContain("libasound2");
    expect(install.split(" ")).toContain("libcups2");
    expect(install.split(" ").length).toBe(3 + APT_PACKAGES.length);
    expect(host.lines.at(-1)).toBe("Chrome's system libraries are installed");
  });

  it("goes through sudo when not root", async () => {
    const host = fakeHost({ root: false });
    await installChromeLibraries(host.deps);
    expect(host.calls.filter((call) => call.includes("apt-get")).every((call) => call.startsWith("sudo apt-get "))).toBe(true);
    expect(host.calls.some((call) => call.startsWith("apt-cache show "))).toBe(true);
  });

  it("installs nothing when apt would remove packages, and says what to run by hand", async () => {
    const host = fakeHost({ simulate: { code: 0, output: "Remv libasound2 [1.2]\nRemv ubuntu-desktop [1]\nInst libasound2t64\n" } });
    await expect(installChromeLibraries(host.deps)).rejects.toThrow(/apt would remove 2 package\(s\).*sudo apt-get install libxcb-shm0/u);
    expect(host.calls.some((call) => call.startsWith("apt-get install -y"))).toBe(false);
  });

  it("fails plainly when the install fails or there is no package manager it knows", async () => {
    await expect(installChromeLibraries(fakeHost({ failInstall: true }).deps)).rejects.toThrow(/apt-get could not install Chrome's libraries/u);
    const fedora = fakeHost({ managers: ["dnf"] });
    await installChromeLibraries(fedora.deps);
    expect(fedora.calls).toEqual([expect.stringMatching(/^dnf install -y nss .* unzip$/u)]);
    await expect(installChromeLibraries(fakeHost({ managers: [] }).deps)).rejects.toThrow(/no supported package manager/u);
  });
});
