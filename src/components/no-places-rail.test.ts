// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; vi.resetModules(); });

const SRC = join(__dirname, "..");
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

it("the desktop window draws no rail of places: no page component renders one", () => {
  const drawing = sources(SRC).filter((file) => readFileSync(file, "utf8").includes("data-places-rail"));
  expect(drawing).toEqual([]);
  expect(readFileSync(join(SRC, "App.tsx"), "utf8")).not.toMatch(/PlacesRail/);
});

it("the switcher stays on the page even when main (an older app) lists places to it", async () => {
  const places = { places: [{ id: "local", name: "This computer", color: null, kind: "computer", opens: true }, { id: "home", name: "My Cloud", color: "blue", kind: "cloud", opens: true, active: true }],
    add: { cloud: true, link: true, address: true }, beside: true };
  Object.assign(window, { duskDesktop: { workspaces: { places: vi.fn(async () => places), state: vi.fn(async () => ({ local: false, name: "My Cloud" })), menu: vi.fn(async () => {}), onChanged: () => () => {} } } });
  const { refreshPlaces } = await import("@/lib/places");
  const { DesktopWorkspaceSwitcher } = await import("./DesktopWorkspaceSwitcher");
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { await refreshPlaces(); root!.render(createElement(DesktopWorkspaceSwitcher, { inline: true })); });
  await act(async () => { await Promise.resolve(); });
  const button = host.querySelector<HTMLButtonElement>("[data-workspace-switcher] button");
  expect(button?.getAttribute("aria-label")).toBe("Switch server: My Cloud");
  expect(button?.closest(".hidden, [class*='md:hidden']")).toBeNull();
  await act(async () => { button!.click(); await Promise.resolve(); });
  expect(window.duskDesktop?.workspaces?.menu).toHaveBeenCalled();
});
