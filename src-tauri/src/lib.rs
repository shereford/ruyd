mod direct;

use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![direct::host_room, direct::join_room, direct::send_chat, direct::stop_room])
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Open Ruyd", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Ruyd", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new().icon(app.default_window_icon().expect("Ruyd app icon").clone()).menu(&menu).tooltip("Ruyd — ready").on_menu_event(|app,event| match event.id.as_ref(){
                "show" => { if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();} },
                "quit" => app.exit(0), _=>{}
            }).build(app)?;
            Ok(())
        })
        .on_window_event(|window,event| if let tauri::WindowEvent::CloseRequested{api,..}=event { api.prevent_close(); let _=window.hide(); })
        .run(tauri::generate_context!()).expect("error while running Ruyd");
}
