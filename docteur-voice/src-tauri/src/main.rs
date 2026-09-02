// Docteur Voice — tray-only native app: global hotkey → record mic → local
// whisper.cpp transcription → intent detection → note/todo dropped into
// Docteur (inbox file, or the local API when the server is reachable) or
// opens Docteur in the browser. No window, minimal footprint at rest.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod audio;
mod config;
mod inbox;
mod intent;
mod transcribe;

use audio::AudioRecorder;
use config::Config;
use intent::Intent;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;

struct AppState {
    recorder: AudioRecorder,
    config: Mutex<Config>,
    listening_enabled: AtomicBool, // master on/off — the hotkey no-ops while false
    is_recording: AtomicBool,      // momentary recording state
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    // Confirmation only — never the dictated content itself beyond a short
    // preview, and never written to a log file.
    let _ = app.notification().builder().title(title).body(body).show();
}

fn set_tray_icon(app: &AppHandle, recording: bool) {
    let bytes: &[u8] = if recording {
        include_bytes!("../icons/tray-listening.png")
    } else {
        include_bytes!("../icons/tray-idle.png")
    };
    if let Ok(image) = tauri::image::Image::from_bytes(bytes) {
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_icon(Some(image));
        }
    }
}

/// Runs the full pipeline once a recording is stopped: transcribe → detect
/// intent → act. Spawned as an async task so the hotkey handler itself never
/// blocks.
async fn handle_recording_finished(app: AppHandle, wav_path: std::path::PathBuf) {
    let cfg = {
        let state = app.state::<AppState>();
        state.config.lock().unwrap().clone()
    };

    let text = match transcribe::transcribe(&cfg, &wav_path) {
        Ok(t) if !t.is_empty() => t,
        Ok(_) => {
            notify(&app, "Docteur Voice", "Aucune parole detectee.");
            return;
        }
        Err(e) => {
            notify(&app, "Docteur Voice — erreur", &e);
            return;
        }
    };

    match intent::detect(&text) {
        Intent::OpenDocteur => {
            let _ = app.opener().open_url(cfg.docteur_url.clone(), None::<&str>);
            notify(&app, "Docteur Voice", "Ouverture de Docteur…");
        }
        Intent::Todo(content) => {
            let via_api = api::add_todo(&cfg.api_base, &content).await;
            let ok_via_api = matches!(via_api, Ok(true));
            if ok_via_api {
                notify(&app, "A faire ajoute", &content);
            } else {
                match inbox::drop_note(&cfg.inbox_dir, &content, Some("todo")) {
                    Ok(()) => notify(
                        &app,
                        "A faire depose dans l'inbox",
                        &format!("{content}\n(sera importe au prochain demarrage de Docteur)"),
                    ),
                    Err(e) => notify(&app, "Docteur Voice — erreur", &e),
                }
            }
        }
        Intent::Note(content) => match inbox::drop_note(&cfg.inbox_dir, &content, None) {
            Ok(()) => notify(&app, "Note deposee dans l'inbox", &content),
            Err(e) => notify(&app, "Docteur Voice — erreur", &e),
        },
    }
}

fn toggle_recording(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.listening_enabled.load(Ordering::SeqCst) {
        return; // master switch off — hotkey does nothing
    }

    let now_recording = !state.is_recording.load(Ordering::SeqCst);
    state.is_recording.store(now_recording, Ordering::SeqCst);
    set_tray_icon(app, now_recording);

    if now_recording {
        if let Err(e) = state.recorder.start() {
            notify(app, "Docteur Voice — erreur micro", &e);
            state.is_recording.store(false, Ordering::SeqCst);
            set_tray_icon(app, false);
        } else {
            notify(app, "Docteur Voice", "Ecoute active — parlez, puis rappuyez sur le raccourci.");
        }
    } else {
        match state.recorder.stop() {
            Ok(wav_path) => {
                notify(app, "Docteur Voice", "Transcription en cours…");
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    handle_recording_finished(app2, wav_path).await;
                });
            }
            Err(e) => notify(app, "Docteur Voice — erreur", &e),
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_recording(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let (cfg, just_created) = config::load_or_init();

            app.manage(AppState {
                recorder: AudioRecorder::spawn(),
                config: Mutex::new(cfg.clone()),
                listening_enabled: AtomicBool::new(true),
                is_recording: AtomicBool::new(false),
            });

            // Register the configured global hotkey (default Ctrl+Alt+D).
            if let Some(shortcut) = parse_shortcut(&cfg.hotkey) {
                let _ = app.global_shortcut().register(shortcut);
            } else {
                eprintln!("[docteur-voice] raccourci invalide dans la config: {}", cfg.hotkey);
            }

            build_tray(app.handle())?;

            if just_created {
                notify(
                    app.handle(),
                    "Docteur Voice — premiere configuration",
                    "Complete le fichier config.json (chemin inbox, whisper-cli, modele) avant la premiere dictee. Menu clic droit > Ouvrir Docteur.",
                );
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Docteur Voice");
}

/// Parses a simple "Ctrl+Alt+D" style accelerator into a Shortcut.
/// Kept intentionally small — only the modifiers/keys this app actually needs.
fn parse_shortcut(spec: &str) -> Option<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;

    for part in spec.split('+') {
        match part.trim().to_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "alt" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "super" | "meta" | "win" => mods |= Modifiers::SUPER,
            key if key.len() == 1 => {
                let c = key.chars().next().unwrap().to_ascii_uppercase();
                code = key_code_for_char(c);
            }
            _ => {}
        }
    }

    code.map(|c| Shortcut::new(Some(mods), c))
}

fn key_code_for_char(c: char) -> Option<Code> {
    use Code::*;
    Some(match c {
        'A' => KeyA, 'B' => KeyB, 'C' => KeyC, 'D' => KeyD, 'E' => KeyE,
        'F' => KeyF, 'G' => KeyG, 'H' => KeyH, 'I' => KeyI, 'J' => KeyJ,
        'K' => KeyK, 'L' => KeyL, 'M' => KeyM, 'N' => KeyN, 'O' => KeyO,
        'P' => KeyP, 'Q' => KeyQ, 'R' => KeyR, 'S' => KeyS, 'T' => KeyT,
        'U' => KeyU, 'V' => KeyV, 'W' => KeyW, 'X' => KeyX, 'Y' => KeyY,
        'Z' => KeyZ,
        _ => return None,
    })
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let listen_toggle = CheckMenuItemBuilder::new("Ecoute activee")
        .id("toggle_listening")
        .checked(true)
        .build(app)?;
    let open_docteur = MenuItemBuilder::new("Ouvrir Docteur").id("open_docteur").build(app)?;
    let autostart_toggle = CheckMenuItemBuilder::new("Lancer au demarrage de Windows")
        .id("toggle_autostart")
        .checked(false) // always OFF by default, per spec — never pre-enabled
        .build(app)?;
    let quit = MenuItemBuilder::new("Quitter").id("quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&listen_toggle)
        .item(&open_docteur)
        .separator()
        .item(&autostart_toggle)
        .separator()
        .item(&quit)
        .build()?;

    let idle_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-idle.png"))?;

    TrayIconBuilder::with_id("main")
        .icon(idle_icon)
        .tooltip("Docteur Voice — pret (raccourci pour dicter)")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "toggle_listening" => {
                let state = app.state::<AppState>();
                let now = !state.listening_enabled.load(Ordering::SeqCst);
                state.listening_enabled.store(now, Ordering::SeqCst);
                notify(
                    app,
                    "Docteur Voice",
                    if now { "Ecoute activee" } else { "Ecoute desactivee (raccourci ignore)" },
                );
            }
            "open_docteur" => {
                let cfg = app.state::<AppState>().config.lock().unwrap().clone();
                let _ = app.opener().open_url(cfg.docteur_url, None::<&str>);
            }
            "toggle_autostart" => {
                let mgr = app.autolaunch();
                let enabled = mgr.is_enabled().unwrap_or(false);
                let result = if enabled { mgr.disable() } else { mgr.enable() };
                if result.is_ok() {
                    notify(
                        app,
                        "Docteur Voice",
                        if enabled { "Lancement au demarrage desactive" } else { "Lancement au demarrage active" },
                    );
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
