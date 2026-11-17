use tauri::Builder;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64};

mod remote_bridge;
mod serial_manager;

#[tauri::command]
fn set_always_on_top(on: bool, window: tauri::Window) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

/// Show the log in Finder/Explorer: selects the file if it exists, otherwise
/// opens (creating if needed) the folder it will be written to.
#[tauri::command]
fn open_log_folder(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = std::path::Path::new(&path);
    if file.is_file() {
        return app.opener().reveal_item_in_dir(file).map_err(|e| e.to_string());
    }
    let dir = file
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or_else(|| "Log path has no folder".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// macOS: Cmd+F/G otherwise reach WKWebView's own find panel before the page
/// can intercept them; menu key equivalents win, so route them to the app's
/// search bar instead. (Windows/Linux have no default menu bar; the frontend
/// handles Ctrl+F there.)
#[cfg(target_os = "macos")]
fn mac_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
    let menu = Menu::default(app)?;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(sub) = item {
            if sub.text()? == "Edit" {
                sub.append(&PredefinedMenuItem::separator(app)?)?;
                sub.append(&MenuItem::with_id(app, "find", "Find…", true, Some("CmdOrCtrl+F"))?)?;
                sub.append(&MenuItem::with_id(app, "find-next", "Find Next", true, Some("CmdOrCtrl+G"))?)?;
                sub.append(&MenuItem::with_id(app, "find-prev", "Find Previous", true, Some("CmdOrCtrl+Shift+G"))?)?;
            }
        }
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu).on_menu_event(|app, event| {
        use tauri::Emitter;
        let id = event.id().as_ref();
        if matches!(id, "find" | "find-next" | "find-prev") {
            let _ = app.emit("menu-find", id.to_string());
        }
    });
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(serial_manager::SerialState {
            port:         Arc::new(Mutex::new(None)),
            running:      Arc::new(AtomicBool::new(false)),
            reconnecting: Arc::new(AtomicBool::new(false)),
            active_port:  Arc::new(Mutex::new(None)),
            flow_mode:    Arc::new(Mutex::new(serial_manager::FlowMode::None)),
            rts:          Arc::new(AtomicBool::new(false)),
            dtr:          Arc::new(AtomicBool::new(false)),
            rts_touched:  Arc::new(AtomicBool::new(false)),
            dtr_touched:  Arc::new(AtomicBool::new(false)),
            tx_paused:    Arc::new(AtomicBool::new(false)),
            // FTDI/Silicon Labs/Prolific chips drive RTS#/DTR# active-low in
            // hardware, so default to corrected polarity (see SettingsContext).
            invert_rts:   Arc::new(AtomicBool::new(true)),
            invert_dtr:   Arc::new(AtomicBool::new(true)),
            invert_cts:   Arc::new(AtomicBool::new(true)),
            invert_dsr:   Arc::new(AtomicBool::new(true)),
            invert_cd:    Arc::new(AtomicBool::new(true)),
            invert_ri:    Arc::new(AtomicBool::new(true)),
            rs485_pre_delay_ms: Arc::new(AtomicU64::new(0)),
            rs485_post_delay_ms: Arc::new(AtomicU64::new(0)),
            half_duplex_pre_delay_ms: Arc::new(AtomicU64::new(0)),
            half_duplex_post_delay_ms: Arc::new(AtomicU64::new(0)),
            tx_key_lock: Arc::new(tokio::sync::Mutex::new(())),
            tx_keyed: Arc::new(AtomicBool::new(false)),
            tx_key_epoch: Arc::new(AtomicU64::new(0)),
            rx_tap: tokio::sync::broadcast::channel(256).0,
            tx_tap: tokio::sync::broadcast::channel(64).0,
            active_baud: Arc::new(AtomicU64::new(0)),
        })
        .manage(remote_bridge::BridgeState::default())
        .invoke_handler(tauri::generate_handler![
            serial_manager::list_ports,
            serial_manager::open_port,
            serial_manager::close_port,
            serial_manager::send_data,
            serial_manager::log_to_file,
            serial_manager::get_connection_status,
            serial_manager::write_to_file,
            serial_manager::set_rts,
            serial_manager::set_dtr,
            serial_manager::set_flow_control,
            serial_manager::set_invert_rts,
            serial_manager::set_invert_dtr,
            serial_manager::set_invert_cts,
            serial_manager::set_invert_dsr,
            serial_manager::set_invert_cd,
            serial_manager::set_invert_ri,
            serial_manager::set_rs485_pre_delay,
            serial_manager::set_rs485_post_delay,
            serial_manager::set_half_duplex_pre_delay,
            serial_manager::set_half_duplex_post_delay,
            serial_manager::read_modem_lines,
            remote_bridge::start_share,
            remote_bridge::stop_share,
            remote_bridge::get_share_status,
            remote_bridge::new_share_token,
            remote_bridge::connect_remote,
            remote_bridge::discover_shares,
            set_always_on_top,
            open_log_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
