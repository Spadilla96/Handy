import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { ResetButton } from "../ui/ResetButton";
import { useSettings } from "../../hooks/useSettings";
import type { AudioDevice, AudioSource } from "@/bindings";

interface AudioSourceSelectorProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const AudioSourceSelector: React.FC<AudioSourceSelectorProps> =
  React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating, isLoading } = useSettings();

    const audioSource = getSetting("audio_source") ?? "microphone";

    const options = [
      {
        value: "microphone",
        label: t("settings.sound.audioSource.microphone"),
      },
      { value: "system", label: t("settings.sound.audioSource.system") },
    ];

    return (
      <SettingContainer
        title={t("settings.sound.audioSource.title")}
        description={t("settings.sound.audioSource.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <Dropdown
          options={options}
          selectedValue={audioSource}
          onSelect={(value) =>
            updateSetting("audio_source", value as AudioSource)
          }
          disabled={isUpdating("audio_source") || isLoading}
        />
      </SettingContainer>
    );
  });

export const SystemAudioDeviceSelector: React.FC<AudioSourceSelectorProps> =
  React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const {
      getSetting,
      updateSetting,
      resetSetting,
      isUpdating,
      isLoading,
      outputDevices,
      refreshOutputDevices,
    } = useSettings();

    const selectedDevice =
      getSetting("system_audio_device") === "default"
        ? "Default"
        : getSetting("system_audio_device") || "Default";

    const deviceOptions = outputDevices.map((device: AudioDevice) => ({
      value: device.name,
      label: device.name,
    }));

    return (
      <SettingContainer
        title={t("settings.sound.systemAudioDevice.title")}
        description={t("settings.sound.systemAudioDevice.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="flex items-center space-x-1">
          <Dropdown
            options={deviceOptions}
            selectedValue={selectedDevice}
            onSelect={(deviceName) =>
              updateSetting("system_audio_device", deviceName)
            }
            placeholder={
              isLoading || outputDevices.length === 0
                ? t("settings.sound.microphone.loading")
                : t("settings.sound.microphone.placeholder")
            }
            disabled={
              isUpdating("system_audio_device") ||
              isLoading ||
              outputDevices.length === 0
            }
            onRefresh={refreshOutputDevices}
          />
          <ResetButton
            onClick={() => resetSetting("system_audio_device")}
            disabled={isUpdating("system_audio_device") || isLoading}
          />
        </div>
      </SettingContainer>
    );
  });

AudioSourceSelector.displayName = "AudioSourceSelector";
SystemAudioDeviceSelector.displayName = "SystemAudioDeviceSelector";
