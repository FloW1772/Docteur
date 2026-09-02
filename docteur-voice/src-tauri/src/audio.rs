// Microphone recording — WAV file on disk, deleted right after transcription.
//
// cpal's `Stream` handle is intentionally NOT Send (it wraps OS/driver
// pointers), so it cannot live inside Tauri's shared app state directly.
// The standard, documented workaround is to give the stream its own
// dedicated thread that owns it locally and reacts to start/stop commands
// over a channel — only the `Sender` needs to be `Send`, which is what gets
// stored in the app state.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

enum Command {
    Start(mpsc::Sender<Result<(), String>>),
    Stop(mpsc::Sender<Result<PathBuf, String>>),
}

// `mpsc::Sender` is Send but NOT Sync, while Tauri's `.manage()` state must be
// Send + Sync (it's accessed from multiple event-handler callbacks that Tauri
// doesn't guarantee run on the same thread). Wrapping it in a Mutex makes the
// whole thing Sync without pulling in another channel crate.
#[derive(Clone)]
pub struct AudioRecorder {
    tx: Arc<Mutex<mpsc::Sender<Command>>>,
}

impl AudioRecorder {
    /// Spawns the dedicated audio thread. Call once at app startup.
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<Command>();
        std::thread::spawn(move || audio_thread_main(rx));
        Self {
            tx: Arc::new(Mutex::new(tx)),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        let (resp_tx, resp_rx) = mpsc::channel();
        self.tx
            .lock()
            .map_err(|_| "audio channel lock poisoned".to_string())?
            .send(Command::Start(resp_tx))
            .map_err(|_| "audio thread unavailable".to_string())?;
        resp_rx
            .recv()
            .map_err(|_| "audio thread did not respond".to_string())?
    }

    /// Stops recording and returns the path to the finished WAV file.
    pub fn stop(&self) -> Result<PathBuf, String> {
        let (resp_tx, resp_rx) = mpsc::channel();
        self.tx
            .lock()
            .map_err(|_| "audio channel lock poisoned".to_string())?
            .send(Command::Stop(resp_tx))
            .map_err(|_| "audio thread unavailable".to_string())?;
        resp_rx
            .recv()
            .map_err(|_| "audio thread did not respond".to_string())?
    }
}

fn temp_wav_path() -> PathBuf {
    std::env::temp_dir().join(format!("docteur-voice-{}.wav", uuid::Uuid::new_v4()))
}

fn audio_thread_main(rx: mpsc::Receiver<Command>) {
    // Kept alive only between Start and Stop — dropping it ends the recording.
    let mut active_stream: Option<cpal::Stream> = None;
    let mut active_path: Option<PathBuf> = None;

    while let Ok(cmd) = rx.recv() {
        match cmd {
            Command::Start(reply) => {
                if active_stream.is_some() {
                    let _ = reply.send(Err("already recording".into()));
                    continue;
                }
                match begin_recording() {
                    Ok((stream, path)) => {
                        active_stream = Some(stream);
                        active_path = Some(path);
                        let _ = reply.send(Ok(()));
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Command::Stop(reply) => {
                // Dropping the stream stops capture immediately.
                active_stream.take();
                match active_path.take() {
                    Some(path) => {
                        let _ = reply.send(Ok(path));
                    }
                    None => {
                        let _ = reply.send(Err("not recording".into()));
                    }
                }
            }
        }
    }
}

fn begin_recording() -> Result<(cpal::Stream, PathBuf), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "aucun micro par defaut trouve".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("config micro indisponible: {e}"))?;

    let spec = WavSpec {
        channels: config.channels(),
        sample_rate: config.sample_rate().0,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let path = temp_wav_path();
    let writer = WavWriter::create(&path, spec).map_err(|e| format!("creation WAV impossible: {e}"))?;
    let writer = Arc::new(Mutex::new(Some(writer)));
    let writer_cb = writer.clone();

    let err_fn = |err| eprintln!("[audio] stream error: {err}"); // no audio content ever logged here

    let stream = device
        .build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                if let Ok(mut guard) = writer_cb.lock() {
                    if let Some(w) = guard.as_mut() {
                        for &sample in data {
                            let _ = w.write_sample(sample);
                        }
                    }
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("ouverture flux micro impossible: {e}"))?;

    stream.play().map_err(|e| format!("demarrage micro impossible: {e}"))?;

    // `writer` (the original Arc, distinct from the `writer_cb` clone moved
    // into the callback above) drops here — that's fine, the callback's own
    // clone keeps the WAV file alive. When the stream itself is later dropped
    // (Command::Stop → active_stream.take()), the callback closure drops with
    // it, releasing the last Arc reference; hound finalizes (patches the WAV
    // header with the real data length) automatically in WavWriter's Drop impl.
    drop(writer);

    Ok((stream, path))
}
