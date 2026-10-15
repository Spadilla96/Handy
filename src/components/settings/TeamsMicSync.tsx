import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface TeamsMicSyncProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const TeamsMicSync: React.FC<TeamsMicSyncProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("teams_mic_sync") ?? false;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(value) => updateSetting("teams_mic_sync", value)}
        isUpdating={isUpdating("teams_mic_sync")}
        label={t("settings.sound.teamsMicSync.label")}
        description={t("settings.sound.teamsMicSync.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  },
);
