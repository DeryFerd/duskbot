// The site's first promise to someone with no AI yet matches the AI step, which offers free models with no account.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../locales/en.json";

const site = (page: string) => readFileSync(join(__dirname, "../../../apps/site/pages", page), "utf8").toLowerCase();

describe("the site on starting with no AI", () => {
  it("is something the AI step still offers", () => {
    expect(en["funnel.ai.freeUntil"]).toContain("free model");
  });

  it.each(["download.html", "home.html", "docs/faq.md", "docs/getting-started.md"])("%s says the app comes with free models", (page) => {
    expect(site(page)).toContain("free models");
  });

  it.each(["docs/faq.md", "docs/getting-started.md"])("%s never says an AI must come from elsewhere", (page) => {
    for (const wrong of ["doesn't come with one", "has no model of its own", "you need some ai", "you need the app and an ai"]) {
      expect(site(page)).not.toContain(wrong);
    }
  });

  it.each(["docs/faq.md", "home.html"])("%s promises free models only from the desktop app", (page) => {
    expect(site(page)).toContain("the desktop app");
    expect(site(page)).not.toContain("the app comes with free models");
  });
});
