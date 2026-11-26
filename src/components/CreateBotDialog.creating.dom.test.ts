// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ actions: [] as Array<{ type: string; onError?: (message: string) => void; onCreated?: () => void }>, otherBotPending: false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  const dispatch = (action: { type: string }) => { fixture.actions.push(action); };
  return { ...original, useStore: () => ({ state: { ...original.initialState, botCreationPending: fixture.otherBotPending }, dispatch }) };
});
vi.mock("@/lib/bot-defaults-prefetch", () => ({ prefetchBotDefaults: () => {} }));

import { CreateBotDialog, openCreateBot } from "./CreateBotDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  fixture.actions = [];
  fixture.otherBotPending = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

const dialog = () => [...document.querySelectorAll<HTMLElement>("[data-create-bot-dialog]")].find((el) => !el.closest("[data-leaving]")) ?? null;

function type(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

async function startCreating() {
  await act(async () => { root.render(createElement(CreateBotDialog)); });
  await act(async () => { openCreateBot(); });
  const field = dialog()!.querySelector<HTMLInputElement>("input")!;
  await act(async () => { type(field, "Waffle"); });
  await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  const made = fixture.actions.find((action) => action.type === "newBot");
  expect(made).toBeTruthy();
  return made!;
}

it("Escape while the bot is being made keeps the dialog, so a failure still shows", async () => {
  const made = await startCreating();
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(dialog()).not.toBeNull();
  await act(async () => { made.onError!("Couldn't make a new bot: The bots folder is read-only"); });
  expect(document.querySelector("[role=alert]")?.textContent).toBe("Couldn't make a new bot: The bots folder is read-only");
});

it("a click outside while the bot is being made keeps the dialog", async () => {
  await startCreating();
  const scrim = dialog()!.previousElementSibling as HTMLElement;
  await act(async () => { scrim.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(dialog()).not.toBeNull();
});

it("Escape still closes the dialog while a bot from somewhere else is being made", async () => {
  fixture.otherBotPending = true;
  await act(async () => { root.render(createElement(CreateBotDialog)); });
  await act(async () => { openCreateBot(); });
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(dialog()).toBeNull();
});

it("puts the keyboard in the new bot's chat box once it is made, however long that took", async () => {
  const made = await startCreating();
  const composer = document.createElement("div");
  composer.dataset.tour = "composer";
  const box = document.createElement("textarea");
  composer.append(box);
  document.body.append(composer);
  dialog()!.querySelector<HTMLInputElement>("input")!.focus();
  await act(async () => { made.onCreated!(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(document.activeElement).toBe(box);
});
