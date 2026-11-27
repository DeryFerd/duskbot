import { describe, expect, it } from "vitest";

import { chainsMentions, inMentionOrder } from "./room-chain.ts";

describe("chainsMentions", () => {
  it("reads a hand-on from one member to the next", () => {
    expect(chainsMentions("@Forge write release notes for v2 from this: ... then @Morning Brief turn forge's notes into a 3 line standup")).toBe(true);
    expect(chainsMentions("@Forge draft it. After that @Quill polish it")).toBe(true);
    expect(chainsMentions("@Forge build it, once it's done @Rivet deploy")).toBe(true);
  });

  it("leaves members addressed side by side to answer at once", () => {
    expect(chainsMentions("@Forge and @Quill, what do you think?")).toBe(false);
    expect(chainsMentions("@Forge then?")).toBe(false);
    expect(chainsMentions("then @Forge do it")).toBe(false);
    expect(chainsMentions("@Forge do this then that, @Quill do the other")).toBe(true);
  });
});

describe("chainsMentions with the members' names", () => {
  const names = ["Scout", "Pepper", "Morning Brief"];
  it("reads a later member told to go then, after an earlier one", () => {
    expect(chainsMentions("@Scout make up a random 4-digit number and say only it. @Pepper then write Scout's number backwards", names)).toBe(true);
    expect(chainsMentions("@Scout what is staging? @Pepper, then turn that into a title", names)).toBe(true);
    expect(chainsMentions("@Scout find it. @Morning Brief next sum it up", names)).toBe(true);
  });

  it("does not read a question or a lone mention as a chain", () => {
    expect(chainsMentions("@Scout hi. @Pepper what's next?", names)).toBe(false);
    expect(chainsMentions("@Scout and @Pepper then?", names)).toBe(false);
    expect(chainsMentions("@Pepper then write it", names)).toBe(false);
    expect(chainsMentions("@Scout @Pepper what do you think?", names)).toBe(false);
  });
});

describe("inMentionOrder", () => {
  it("orders members as the message names them", () => {
    const members = [{ name: "Morning Brief" }, { name: "Forge" }];
    expect(inMentionOrder(members, "@Forge write it, then @Morning Brief sum it up").map((member) => member.name)).toEqual(["Forge", "Morning Brief"]);
  });
});
