use tauri::AppHandle;

use crate::overlay;

/// Mouse-down on the overlay: let the user drag it somewhere else.
#[tauri::command]
#[specta::specta]
pub fn begin_overlay_drag(app: AppHandle) {
    overlay::begin_overlay_drag(&app);
}

/// Hide the overlay for the rest of the session (restore it from the tray).
#[tauri::command]
#[specta::specta]
pub fn minimize_overlay(app: AppHandle) {
    overlay::minimize_overlay(&app);
}

/// Show the Live overlay as the small pill (`true`) or the text panel.
#[tauri::command]
#[specta::specta]
pub fn set_overlay_live_compact(app: AppHandle, compact: bool) {
    overlay::set_live_compact(&app, compact);
}

/// Return a dragged overlay to the configured top/bottom placement.
#[tauri::command]
#[specta::specta]
pub fn reset_overlay_position(app: AppHandle) {
    overlay::reset_overlay_position(&app);
}
