import { describe, expect, it } from "vitest";
import { MAC_TRAFFIC_LIGHT_CLEAR_X, narrowPastLights } from "./DesktopCapabilities";

// #81: a narrow Mac window with its frame off put the bot list's button under the traffic lights
describe("a narrow window's corner", () => {
  it("moves past the traffic lights on a Mac window with its frame off", () => {
    const style = narrowPastLights({ windowChrome: "mac-inset", windowFrame: false }) as Record<string, string>;
    expect(parseInt(style["--narrow-button-x"]!, 10)).toBeGreaterThan(76);
    // the header's lead clears the button (40px) as well
    expect(parseInt(style["--narrow-lead"]!, 10)).toBeGreaterThanOrEqual(parseInt(style["--narrow-button-x"]!, 10) + 40);
    expect(MAC_TRAFFIC_LIGHT_CLEAR_X).toBeGreaterThan(76);
  });

  it("leaves a framed window, Windows and the browser as they are", () => {
    expect(narrowPastLights({ windowChrome: "mac-inset", windowFrame: true })).toBeUndefined();
    expect(narrowPastLights({ windowChrome: "mac-inset" } as never)).toBeUndefined();
    expect(narrowPastLights({ windowChrome: "win-caption", windowFrame: false })).toBeUndefined();
    expect(narrowPastLights({ windowChrome: "native" } as never)).toBeUndefined();
  });
});
