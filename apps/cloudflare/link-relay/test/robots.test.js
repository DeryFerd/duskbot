import { describe, expect, it, vi } from "vitest";

// the durable objects need workerd; these answers never reach them
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { default: worker } = await import("../src/index.js");

describe("relay hosts and search engines", () => {
  it("serves a robots.txt that shuts every crawler out", async () => {
    const res = await worker.fetch(new Request("https://relay.dusk.bot/robots.txt"), {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("says noindex on the health answer and on a missing address", async () => {
    for (const path of ["/", "/nope"]) {
      const res = await worker.fetch(new Request(`https://relay.dusk.bot${path}`), {});
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      expect(res.headers.get("content-type"), path).toMatch(/json/);
    }
  });
});
