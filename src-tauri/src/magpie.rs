//! Launch the Magpie component included in the Windows installer.

use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Runtime};

pub const WORKBUDDY_ARG: &str = "--workbuddy";
pub const GATEWAYS_ARG: &str = "--workbuddy-gateways";

pub fn print_gateways() {
    let config = wb_switch_core::modules::proxy::load_proxy_config().resolved();
    let endpoint = |value: &wb_switch_core::modules::proxy::Endpoint| {
        serde_json::json!({
            "enabled": value.enabled,
            "listen": value.listen,
            "api_key": value.api_key,
        })
    };
    println!(
        "{}",
        serde_json::json!({
            "domestic": endpoint(&config.domestic),
            "international": endpoint(&config.international),
        })
    );
}

fn executable() -> Option<PathBuf> {
    if !cfg!(target_os = "windows") || crate::is_screenshot_demo() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let companion = exe.parent()?.join("magpie").join("magpie.exe");
    companion.is_file().then_some(companion)
}

pub fn available() -> bool {
    executable().is_some()
}

pub fn launch(silent: bool) -> bool {
    let Some(exe) = executable() else {
        return false;
    };
    let mut command = Command::new(exe);
    command.env("MAGPIE_NO_INSTALL", "1");
    command.arg(if silent { "tray" } else { "gui" });
    match command.spawn() {
        Ok(mut child) => {
            // A second Magpie launch asks its existing instance to show its window.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(error) => {
            eprintln!("[magpie] 启动失败: {error}");
            false
        }
    }
}

pub fn open<R: Runtime>(app: &AppHandle<R>) {
    if !launch(false) {
        crate::tray::show_main_window(app);
    }
}
