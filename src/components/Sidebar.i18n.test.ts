import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { initialState, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { ConfirmDialogCard } from "./ConfirmDialog";
import { BotListItem, botConfirmCopy, botRowProps, roomDeleteCopy } from "./Sidebar";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...overrides,
}) as Bot;

const rowProps = (value: Bot) => botRowProps(initialState, () => {}, value, { density: "comfortable", query: "", onMenu: () => {} });

function renderRow(value: Bot): string {
  return renderToStaticMarkup(createElement(BotListItem, rowProps(value)));
}

afterEach(() => {
  setLocale("en");
});

describe("sidebar rows", () => {

  it("translates the row's own copy and its actions", () => {
    setLocale("pt-br");
    const markup = renderRow(bot({ chiefOfStaff: true, busy: true }));

    expect(markup).toContain(`<span class="sr-only">${t("chat.activity.working")}</span>`);
    expect(t("chat.activity.working")).not.toBe("Working");
    expect(markup).not.toContain("Chief of staff");

    setLocale("ja");
    expect(renderRow(bot())).toContain(`aria-label="${t("sidebar.bot.actions", { name: "Atlas" })}"`);
  });
});

describe("archive / delete confirmation copy", () => {
  it("translates and keeps the bot's name out of the catalog", () => {
    setLocale("pt-br");
    const archive = botConfirmCopy("archive", "Juniper");
    expect(archive.title).toBe("Arquivar Juniper?");
    expect(archive.confirmLabel).toBe("Arquivar");

    const remove = botConfirmCopy("delete", "Willow");
    expect(remove.title).toContain("Willow");
    expect(remove.confirmLabel).toBe("Excluir");
    setLocale("zh");
    expect(botConfirmCopy("delete", "Willow").title).toBe("删除 Willow？");
  });
});

describe("room delete confirmation copy", () => {
  it("names the group chat and says in one line what goes and what stays", () => {
    const copy = roomDeleteCopy({ name: "Launch plan" });
    expect(copy.title).toBe("Delete Launch plan?");
    expect(copy.body).toBe("Its messages, threads and routines go too. The bots stay.");
    expect(copy.confirmLabel).toBe(t("sidebar.room.deleteChannel"));
    expect(copy.tone).toBe("danger");
  });

  it("calls a bot-to-bot room a chat, never a thread", () => {
    const copy = roomDeleteCopy({ name: "Pen ⇄ Ink", dm: true });
    expect(copy.title).toBe("Delete Pen ⇄ Ink?");
    expect(copy.body).toBe("Its messages go too. The bots stay.");
    expect(copy.body).not.toMatch(/thread/);
    expect(copy.body).not.toMatch(/group chat/);
    expect(copy.confirmLabel).toBe(t("sidebar.room.deleteBotChat"));
  });

  it("renders as a danger alert dialog with Cancel before the delete action", () => {
    const markup = renderToStaticMarkup(createElement(ConfirmDialogCard, {
      open: true,
      ...roomDeleteCopy({ name: "Launch plan" }),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Delete Launch plan?");
    expect(markup.indexOf(">Cancel</button>")).toBeLessThan(markup.indexOf(">Delete group chat</button>"));
    expect(markup).toContain("bg-[#e72e3b]");
  });

  it("offers a gentler way beside the destructive one when there is one, after Cancel", () => {
    const markup = renderToStaticMarkup(createElement(ConfirmDialogCard, {
      open: true, title: "delete Chief?", body: "Its chats hold your setup.", confirmLabel: "Delete", tone: "danger",
      onCancel: vi.fn(), onConfirm: vi.fn(), alternative: { label: "archive instead", onClick: vi.fn() },
    }));
    expect(markup.indexOf(">cancel</button>")).toBeLessThan(markup.indexOf(">archive instead</button>"));
    expect(markup.indexOf(">archive instead</button>")).toBeLessThan(markup.indexOf(">Delete</button>"));
  });

  it("keeps the room's name intact in other languages", () => {
    setLocale("pt-br");
    expect(roomDeleteCopy({ name: "Launch plan" }).title).toContain("Launch plan");
    expect(roomDeleteCopy({ name: "Launch plan" }).confirmLabel).toBe(t("sidebar.room.deleteChannel"));
  });
});
