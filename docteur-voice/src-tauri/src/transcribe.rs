// Local transcription via the whisper.cpp CLI (whisper-cli.exe / main.exe),
// invoked as a child process with an ARGUMENT ARRAY — never a shell string —
// matching the same command-injection-safe pattern already used in
// cortex-server (spawn/execFile, never exec with concatenation).
//
// WHY shell out to whisper.cpp's CLI rather than link whisper-rs directly:
// whisper-rs needs a C/C++ toolchain + CMake to build its bundled whisper.cpp
// at compile time, which is a heavy, failure-prone build step for a small
// tray utility, and pulls large native code into this binary. Shelling out to
// the official prebuilt whisper-cli.exe keeps this crate pure-Rust, keeps
// the model file (and the ~150-600 MB it represents) OUTSIDE the app itself
// (downloaded once by the user, reused release after release), and is the
// same "spawn an external local tool, capture its output" shape Docteur's
// own server already uses for yt-dlp/Whisper. The trade-off is one extra
// manual install step, covered in the README.
//
// Nothing here ever touches the network — no audio, no transcript, ever
// leaves this call.

use crate::config::Config;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn transcribe(cfg: &Config, wav_path: &Path) -> Result<String, String> {
    if !Path::new(&cfg.whisper_cli_path).exists() {
        return Err(format!(
            "whisper_cli_path introuvable : {}",
            cfg.whisper_cli_path
        ));
    }
    if !Path::new(&cfg.whisper_model_path).exists() {
        return Err(format!(
            "whisper_model_path introuvable : {}",
            cfg.whisper_model_path
        ));
    }

    let out_prefix = wav_path.with_extension(""); // whisper-cli appends .txt itself
    let lang = if cfg.language.trim().is_empty() {
        "auto".to_string()
    } else {
        cfg.language.clone()
    };

    let status = Command::new(&cfg.whisper_cli_path)
        .args([
            "-m",
            &cfg.whisper_model_path,
            "-f",
            &wav_path.to_string_lossy(),
            "-l",
            &lang,
            "-otxt",
            "-of",
            &out_prefix.to_string_lossy(),
            "-np", // no progress/debug prints
            "-nt", // no timestamps in the .txt output
        ])
        .status()
        .map_err(|e| format!("lancement whisper-cli impossible : {e}"))?;

    let txt_path: PathBuf = out_prefix.with_extension("txt");
    let result = if status.success() && txt_path.exists() {
        std::fs::read_to_string(&txt_path)
            .map(|s| s.trim().to_string())
            .map_err(|e| format!("lecture transcription impossible : {e}"))
    } else {
        Err(format!("whisper-cli a echoue (code {:?})", status.code()))
    };

    // Never keep the audio (or its intermediate transcript file) around —
    // delete both right away regardless of success/failure.
    let _ = std::fs::remove_file(wav_path);
    let _ = std::fs::remove_file(&txt_path);

    result
}
