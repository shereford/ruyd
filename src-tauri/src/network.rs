use serde::Serialize;
use std::{fs, path::PathBuf, process::Command};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    platform: String,
    wireguard_installed: bool,
    tunnel_service_active: bool,
    detail: String,
}

fn wireguard_path() -> PathBuf {
    std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
        .join("WireGuard")
        .join("wireguard.exe")
}

#[tauri::command]
pub fn network_status() -> NetworkStatus {
    if !cfg!(target_os = "windows") {
        return NetworkStatus { platform: std::env::consts::OS.into(), wireguard_installed: false, tunnel_service_active: false, detail: "The virtual LAN is supported on Windows only.".into() };
    }
    let installed = wireguard_path().is_file();
    let active = Command::new("sc.exe").args(["query", "WireGuardTunnel$Ruyd"]).output().map(|v| v.status.success()).unwrap_or(false);
    NetworkStatus {
        platform: "windows".into(), wireguard_installed: installed, tunnel_service_active: active,
        detail: if !installed { "Install WireGuard for Windows before starting a game tunnel.".into() } else if active { "Ruyd game tunnel is active.".into() } else { "WireGuard is ready; no game tunnel is active.".into() },
    }
}

#[tauri::command]
pub fn install_tunnel(config: String) -> Result<(), String> {
    if !cfg!(target_os = "windows") { return Err("Windows is required".into()); }
    if config.len() > 32_768 || !config.contains("[Interface]") || !config.contains("PrivateKey") || !config.contains("Address") {
        return Err("Invalid WireGuard configuration".into());
    }
    let executable = wireguard_path();
    if !executable.is_file() { return Err("WireGuard for Windows is not installed".into()); }
    let path = std::env::temp_dir().join("Ruyd.conf");
    fs::write(&path, config.as_bytes()).map_err(|e| e.to_string())?;
    let result = Command::new(executable).arg("/installtunnelservice").arg(&path).status().map_err(|e| e.to_string());
    let _ = fs::remove_file(&path);
    match result { Ok(status) if status.success() => Ok(()), Ok(status) => Err(format!("WireGuard exited with {status}")), Err(error) => Err(error) }
}

#[tauri::command]
pub fn remove_tunnel() -> Result<(), String> {
    if !cfg!(target_os = "windows") { return Err("Windows is required".into()); }
    let status = Command::new(wireguard_path()).args(["/uninstalltunnelservice", "Ruyd"]).status().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("WireGuard exited with {status}")) }
}
