import React from "react";
import { useTranslation } from "react-i18next";
import {
  Cog,
  FlaskConical,
  History,
  Info,
  Sparkles,
  Cpu,
  Users,
} from "lucide-react";
import DenDenMushi from "./icons/DenDenMushi";
import { useSettings } from "../hooks/useSettings";
import {
  GeneralSettings,
  AdvancedSettings,
  HistorySettings,
  DebugSettings,
  AboutSettings,
  PostProcessingSettings,
  ModelsSettings,
  MeetingsSettings,
} from "./settings";

export type SidebarSection = keyof typeof SECTIONS_CONFIG;

interface IconProps {
  width?: number | string;
  height?: number | string;
  size?: number | string;
  className?: string;
  [key: string]: any;
}

interface SectionConfig {
  labelKey: string;
  icon: React.ComponentType<IconProps>;
  component: React.ComponentType;
  enabled: (settings: any) => boolean;
}

export const SECTIONS_CONFIG = {
  general: {
    labelKey: "sidebar.general",
    icon: DenDenMushi,
    component: GeneralSettings,
    enabled: () => true,
  },
  history: {
    labelKey: "sidebar.history",
    icon: History,
    component: HistorySettings,
    enabled: () => true,
  },
  meetings: {
    labelKey: "sidebar.meetings",
    icon: Users,
    component: MeetingsSettings,
    enabled: () => true,
  },
  models: {
    labelKey: "sidebar.models",
    icon: Cpu,
    component: ModelsSettings,
    enabled: () => true,
  },
  advanced: {
    labelKey: "sidebar.advanced",
    icon: Cog,
    component: AdvancedSettings,
    enabled: () => true,
  },
  postprocessing: {
    labelKey: "sidebar.postProcessing",
    icon: Sparkles,
    component: PostProcessingSettings,
    enabled: (settings) => settings?.post_process_enabled ?? false,
  },
  debug: {
    labelKey: "sidebar.debug",
    icon: FlaskConical,
    component: DebugSettings,
    enabled: (settings) => settings?.debug_mode ?? false,
  },
  about: {
    labelKey: "sidebar.about",
    icon: Info,
    component: AboutSettings,
    enabled: () => true,
  },
} as const satisfies Record<string, SectionConfig>;

const MAIN_SECTION_IDS: SidebarSection[] = ["general", "history", "meetings"];

interface SidebarProps {
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSectionChange,
}) => {
  const { t } = useTranslation();
  const { settings } = useSettings();

  const availableSections = Object.entries(SECTIONS_CONFIG)
    .filter(([_, config]) => config.enabled(settings))
    .map(([id, config]) => ({ id: id as SidebarSection, ...config }));

  // Primary content areas sit at the top of the rail; configuration pages
  // are grouped at the bottom.
  const mainSections = availableSections.filter((s) =>
    MAIN_SECTION_IDS.includes(s.id),
  );
  const footerSections = availableSections.filter(
    (s) => !MAIN_SECTION_IDS.includes(s.id),
  );

  const renderItem = (section: (typeof availableSections)[number]) => {
    const Icon = section.icon;
    const isActive = activeSection === section.id;
    return (
      <button
        key={section.id}
        type="button"
        aria-current={isActive ? "page" : undefined}
        title={t(section.labelKey)}
        onClick={() => onSectionChange(section.id)}
        className={`flex flex-col items-center gap-1 w-full py-2 px-1 rounded-xl cursor-pointer transition-colors ${
          isActive
            ? "bg-logo-primary/15 text-logo-primary"
            : "text-text/70 hover:bg-mid-gray/15 hover:text-text"
        }`}
      >
        <Icon width={22} height={22} className="shrink-0" />
        <span className="text-[11px] leading-tight font-medium w-full truncate text-center">
          {t(section.labelKey)}
        </span>
      </button>
    );
  };

  return (
    <nav
      aria-label={t("sidebar.navigation", { defaultValue: "Navigation" })}
      className="flex flex-col w-[84px] shrink-0 h-full border-e border-mid-gray/20 items-center px-2 py-3 gap-1"
    >
      <div className="mb-3 mt-1">
        <DenDenMushi variant="color" width={40} height={40} />
      </div>
      {mainSections.map(renderItem)}
      <div className="flex-1" />
      {footerSections.map(renderItem)}
    </nav>
  );
};
