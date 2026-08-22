use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tauri_plugin_notification::NotificationExt;

const TRAY_ID: &str = "ruyd";

/// Closing the window hides Ruyd instead of quitting, which is not what the close button
/// does in most Windows applications. Say so once per run, the first time it happens.
static EXPLAINED_CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);

/// Reflects the room state in the tray tooltip. Once the window is hidden the tooltip
/// is the only status the user can see without reopening Ruyd.
#[tauri::command]
fn set_tray_status(app: AppHandle, status: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(status));
    }
}

/// Raises a desktop notification only while the window is hidden. Ruyd is tray-first,
/// so anything that happens after close-to-background is otherwise invisible. Nothing
/// is raised while the window is on screen, because the UI is already showing it.
#[tauri::command]
fn notify_when_hidden(app: AppHandle, title: String, body: String) {
    let visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(true);
    if visible {
        return;
    }
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![set_tray_status, notify_when_hidden])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Open Ruyd", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Ruyd", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().expect("Ruyd app icon").clone())
                .menu(&menu)
                .tooltip("Ruyd - ready")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                if !EXPLAINED_CLOSE_TO_TRAY.swap(true, Ordering::Relaxed) {
                    let _ = window
                        .app_handle()
                        .notification()
                        .builder()
                        .title("Ruyd is still running")
                        .body("Your room stays open. Reopen Ruyd or quit it from the system tray.")
                        .show();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Ruyd");
}
