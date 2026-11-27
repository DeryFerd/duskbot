import type { Bot } from "@/state/store";
import type { useBotSettingsDerived } from "../../bot-settings/useBotSettingsDerived";
import { BackupsModal } from "./BackupsModal";
import { FolderModal } from "./FolderModal";
import { InstructionsModal } from "./InstructionsModal";
import { MemoryModal } from "./MemoryModal";
import type { SheetPage } from "./panel-modal";
import { IdentityModal, PermissionsModal, SlackModal, ToolsModal } from "./SectionModals";
import { SessionsModal } from "./SessionsModal";
import { SkillsModal } from "./SkillsModal";
import { WhereModal } from "./WhereModal";

export function PanelModal({ page, bot, derived, onClose }: {
  page: SheetPage;
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  onClose: () => void;
}) {
  switch (page) {
    case "instructions":
      return <InstructionsModal bot={bot} derived={derived} onClose={onClose} />;
    case "memory":
      return <MemoryModal bot={bot} derived={derived} onClose={onClose} />;
    case "skills":
      return <SkillsModal bot={bot} onClose={onClose} />;
    case "identity":
      return <IdentityModal bot={bot} derived={derived} onClose={onClose} />;
    case "tools":
      return <ToolsModal bot={bot} derived={derived} onClose={onClose} />;
    case "permissions":
      return <PermissionsModal bot={bot} derived={derived} onClose={onClose} />;
    case "folder":
      return <FolderModal bot={bot} onClose={onClose} />;
    case "where":
      return <WhereModal bot={bot} derived={derived} onClose={onClose} />;
    case "sessions":
      return <SessionsModal bot={bot} derived={derived} />;
    case "backups":
      return <BackupsModal bot={bot} derived={derived} onClose={onClose} />;
    case "slack":
      return <SlackModal bot={bot} onClose={onClose} />;
  }
}
