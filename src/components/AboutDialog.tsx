import { useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { createPortal } from "react-dom";

import {
  DOCS_URL,
  LICENSE_URL,
  RELEASES_URL,
  THIRD_PARTY_NOTICES_URL,
  appVersion,
  openExternalLink,
  platformLabel,
} from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { useOtherServerName } from "@/lib/other-server";
import { copyText } from "@/lib/copy-text";
import { useDialogKeys } from "./ui/GrokDialog";
import { SettingRow, SettingsGroup, SettingsRows, SIMPLE_BUTTONS } from "./SettingsPrimitives";
import "../styles/settings.css";
import { Icon } from "./Icon";
import { ChevronRight } from "../icons";
import { ScrimMotion, SheetMotion, useDialogMotion } from "./ui/SheetMotion";
import { cn } from "@/lib/cn";

/** The app's own version first; `server` (useOtherServerName: set only when the app's window shows another server) adds a
 * line naming it with the version its page runs. A browser, or an app too old to say, keeps the page's version on one line. */
export function aboutVersionLines({ app, bundle, platform, server }: {
  app?: { version: string } | null;
  bundle: string;
  platform: string | null;
  server: string | null;
}): string[] {
  const line = (version: string) => `${t("about.version", { version })}${platform ? ` · ${platform}` : ""}`;
  if (!app?.version) return [line(bundle)];
  return server ? [line(app.version), t("about.connectedTo", { name: server, version: bundle })] : [line(app.version)];
}

/** Grok's About: the icon, the name and version, Copy version info, and a close at the corner. */
export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <AnimatePresence>{open && <AboutSheet key="about" onClose={onClose} />}</AnimatePresence>;
}

function AboutSheet({ onClose }: { onClose: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const close = useDialogKeys(sheet, onClose);
  const played = useDialogMotion();
  const server = useOtherServerName(true);
  const [copied, setCopied] = useState(false);
  const lines = aboutVersionLines({ app: window.duskDesktop?.app, bundle: appVersion(), platform: platformLabel(window.duskDesktop?.platform), server });
  const [version, connected] = lines;
  const copy = () => void copyText([productName(), ...lines].join("\n")).then((result) => setCopied(result === "copied"));

  return createPortal(
    <div {...played.layer} data-settings-sheet data-settings-look="simple" className="settings-scrim">
      <ScrimMotion {...played.scrim} aria-hidden="true" className="settings-backdrop" onMouseDown={() => close.current()} />
      <SheetMotion
        {...played.sheet}
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        tabIndex={-1}
        className="settings-dialog"
        style={{ width: "min(420px, 100vw - 32px)" }}
      >
        <section className="settings-panel min-h-0">
          <button type="button" aria-label={t("common.close")} onClick={() => close.current()} className="settings-close">
            <Icon name="close" size={14} />
          </button>
          <div className="settings-pane-header">
            <h2 id="about-dialog-title" className="settings-pane-title">{productName()}</h2>
          </div>
          <div className="settings-scroll">
            <div className={cn("settings-pane", SIMPLE_BUTTONS)} style={{ paddingBottom: 20 }}>
              <SettingsGroup footnote={t("about.license")}>
                <SettingsRows>
                  <SettingRow title={version ?? ""} icon={<img src="/app-icon.svg" alt="" width={24} height={24} className="size-6" />}>
                    <button type="button" data-autofocus onClick={copy} className="ui-button">
                      {copied ? t("about.copied") : t("about.copyVersion")}
                    </button>
                  </SettingRow>
                  {connected && <SettingRow title={connected}>{null}</SettingRow>}
                </SettingsRows>
              </SettingsGroup>
              <SettingsGroup>
                <SettingsRows>
                  <AboutLink href={DOCS_URL} label={t("about.docs")} />
                  <AboutLink href={RELEASES_URL} label={t("about.releases")} />
                  <AboutLink href={LICENSE_URL} label={t("about.licenseLink")} />
                  <a href={THIRD_PARTY_NOTICES_URL} target="_blank" rel="license noopener noreferrer" className={aboutRowCls}>
                    <span>{t("about.notices")}</span>
                    <ChevronRight size={12} aria-hidden="true" className="text-ink-secondary" />
                  </a>
                </SettingsRows>
              </SettingsGroup>
            </div>
          </div>
        </section>
      </SheetMotion>
    </div>,
    document.body,
  );
}

const aboutRowCls = "flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start text-[13px] leading-[18px] tracking-[0.015em] text-ink transition-[background-color] duration-[120ms] ease-[ease] hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";

function AboutLink({ href, label }: { href: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => void openExternalLink(href)}
      className={aboutRowCls}
    >
      <span>{label}</span>
      <ChevronRight size={12} aria-hidden="true" className="text-ink-secondary" />
    </button>
  );
}
