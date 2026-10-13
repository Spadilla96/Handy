use cpal::traits::{DeviceTrait, HostTrait};

pub struct CpalDeviceInfo {
    pub index: String,
    pub name: String,
    pub is_default: bool,
    pub device: cpal::Device,
}

pub fn list_input_devices() -> Result<Vec<CpalDeviceInfo>, Box<dyn std::error::Error>> {
    let host = crate::audio_toolkit::get_cpal_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());

    let mut out = Vec::<CpalDeviceInfo>::new();

    for (index, device) in host.input_devices()?.enumerate() {
        let name = device.name().unwrap_or_else(|_| "Unknown".into());

        let is_default = Some(name.clone()) == default_name;

        out.push(CpalDeviceInfo {
            index: index.to_string(),
            name,
            is_default,
            device,
        });
    }

    Ok(out)
}

pub fn list_output_devices() -> Result<Vec<CpalDeviceInfo>, Box<dyn std::error::Error>> {
    let host = crate::audio_toolkit::get_cpal_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());

    let mut out = Vec::<CpalDeviceInfo>::new();

    for (index, device) in host.output_devices()?.enumerate() {
        let name = device.name().unwrap_or_else(|_| "Unknown".into());

        let is_default = Some(name.clone()) == default_name;

        out.push(CpalDeviceInfo {
            index: index.to_string(),
            name,
            is_default,
            device,
        });
    }

    Ok(out)
}

/// Choose a capture device from `(name, is_default, device)` candidates.
///
/// Prefers the user's `preferred` device (or the system default when none is
/// set), then the default, then anything else, skipping names in `avoid`
/// (devices that just failed). If every candidate is avoided, the preferred
/// or default one is returned anyway. The flag is true when the choice is
/// what the user asked for rather than a stand-in.
pub fn pick_capture_device<T>(
    candidates: Vec<(String, bool, T)>,
    preferred: Option<&str>,
    avoid: &[String],
) -> Option<(T, bool)> {
    let is_wanted = |name: &str, is_default: bool| match preferred {
        Some(preferred) => name == preferred,
        None => is_default,
    };
    let rank = |name: &str, is_default: bool| {
        let avoided = avoid.iter().any(|a| a == name);
        match (avoided, is_wanted(name, is_default), is_default) {
            (false, true, _) => 0,
            (false, false, true) => 1,
            (false, false, false) => 2,
            (true, true, _) => 3,
            (true, false, true) => 4,
            (true, false, false) => 5,
        }
    };
    candidates
        .into_iter()
        .enumerate()
        .filter(|(_, (name, is_default, _))| rank(name, *is_default) != 5)
        .min_by_key(|(index, (name, is_default, _))| (rank(name, *is_default), *index))
        .map(|(_, (name, is_default, device))| {
            let wanted = is_wanted(&name, is_default);
            (device, wanted)
        })
}

#[cfg(test)]
mod tests {
    use super::pick_capture_device;

    fn candidates() -> Vec<(String, bool, &'static str)> {
        vec![
            ("Built-in".to_string(), true, "builtin"),
            ("Headset".to_string(), false, "headset"),
            ("USB".to_string(), false, "usb"),
        ]
    }

    #[test]
    fn picks_the_preferred_device_when_present() {
        assert_eq!(
            pick_capture_device(candidates(), Some("Headset"), &[]),
            Some(("headset", true))
        );
    }

    #[test]
    fn falls_back_to_the_default_when_the_preferred_is_missing_or_failed() {
        assert_eq!(
            pick_capture_device(candidates(), Some("Gone"), &[]),
            Some(("builtin", false))
        );
        assert_eq!(
            pick_capture_device(candidates(), Some("Headset"), &["Headset".to_string()]),
            Some(("builtin", false))
        );
    }

    #[test]
    fn avoids_a_failed_default_when_another_device_exists() {
        assert_eq!(
            pick_capture_device(candidates(), None, &["Built-in".to_string()]),
            Some(("headset", false))
        );
    }

    #[test]
    fn reuses_the_preferred_device_when_everything_failed() {
        let avoid = ["Built-in", "Headset", "USB"].map(String::from);
        assert_eq!(
            pick_capture_device(candidates(), Some("Headset"), &avoid),
            Some(("headset", true))
        );
        assert_eq!(pick_capture_device(Vec::<(String, bool, ())>::new(), None, &[]), None);
    }
}
