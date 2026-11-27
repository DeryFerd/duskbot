// The phone app as an Android (or iPhone) build shows it, against a fixture server, with the update answers faked
// (scripts/testing/updates-ui-fakes.ts). ?os=android|ios, ?v=<app version>, ?last=<version the phone ran before>.
// Served only by scripts/verify-updates-ui.ts.
import { mountMobile } from "../../src/mobile/boot";
import { webPlatform } from "../../src/mobile/platform";
import { installUpdateFakes } from "./updates-ui-fakes";

const params = new URLSearchParams(location.search);
installUpdateFakes(params);
const last = params.get("last");
if (last) localStorage.setItem("dusk-whats-new:phone", last);
mountMobile({ ...webPlatform(), kind: (params.get("os") ?? "android") as "android", appVersion: params.get("v") ?? "1.2.9" });
