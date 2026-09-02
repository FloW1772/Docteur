// Configuration is a hand-edited JSON file, not a settings window — this app
// has no window at all (tray-only, minimal memory footprint). First run
// writes a template with placeholders and notifies the user to fill it in.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Absolute path to Docteur's cortex-server/data/inbox/ folder.
    /// This is the ONLY write path used when the server isn't reachable —
    /// one-way file drop, no network endpoint, matches the existing inbox
    /// mechanism already validated in Docteur itself.
    pub inbox_dir: String,
    /// Opened in the default browser for "ouvre docteur".
    pub docteur_url: String,
    /// cortex-server's local API base — ONLY ever called on localhost/127.0.0.1.
    pub api_base: String,
    /// Global hotkey that toggles recording on/off. Tauri accelerator syntax.
    pub hotkey: String,
    /// Path to a whisper.cpp CLI executable (whisper-cli.exe / main.exe).
    pub whisper_cli_path: String,
    /// Path to a GGML whisper model file (e.g. ggml-base.bin).
    pub whisper_model_path: String,
    /// Whisper language hint ("fr", "en", or "auto").
    pub language: String,
    /// Mirrors the OS autostart registration state — kept in sync by the app,
    /// disabled by default as required.
    pub launch_at_startup: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            inbox_dir: String::from("REPLACE_ME\\cortex-server\\data\\inbox"),
            docteur_url: String::from("http://localhost:5173"),
            api_base: String::from("http://127.0.0.1:3001"),
            hotkey: String::from("Ctrl+Alt+D"),
            whisper_cli_path: String::from("REPLACE_ME\\whisper-cli.exe"),
            whisper_model_path: String::from("REPLACE_ME\\ggml-base.bin"),
            language: String::from("fr"),
            launch_at_startup: false,
        }
    }
}

fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("docteur-voice")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

/// Loads the config, writing a default template on first run.
/// Returns (config, was_just_created).
pub fn load_or_init() -> (Config, bool) {
    let path = config_path();
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<Config>(&raw) {
            return (cfg, false);
        }
    }

    let cfg = Config::default();
    let _ = fs::create_dir_all(config_dir());
    if let Ok(json) = serde_json::to_string_pretty(&cfg) {
        let _ = fs::write(&path, json);
    }
    (cfg, true)
}

pub fn is_configured(cfg: &Config) -> bool {
    !cfg.inbox_dir.contains("REPLACE_ME") && !cfg.whisper_cli_path.contains("REPLACE_ME")
}

pub fn save(cfg: &Config) -> std::io::Result<()> {
    let _ = fs::create_dir_all(config_dir());
    let json = serde_json::to_string_pretty(cfg).unwrap_or_default();
    fs::write(config_path(), json)
}
