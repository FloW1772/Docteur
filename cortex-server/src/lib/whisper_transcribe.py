"""
Transcribes a WAV file with faster-whisper (model: small).
Usage: python whisper_transcribe.py <audio_path> [model_size] [--segments]
Outputs progress lines: PROGRESS:<0-100>
Outputs final JSON line: {"text": "...", "language": "fr", "duration_s": 42.3}
With --segments (any position after audio_path), also includes:
  "segments": [{"start": 0.0, "end": 4.2, "text": "..."}, ...]
Segment boundaries from faster-whisper naturally fall on speech pauses —
used by the long-video pipeline to cut 10-20 min chunks on natural breaks
instead of blindly slicing by duration.
"""
import sys
import json
import os

if len(sys.argv) < 2:
    print(json.dumps({"error": "No audio path provided"}))
    sys.exit(1)

audio_path = sys.argv[1]
rest = sys.argv[2:]
want_segments = '--segments' in rest
model_size = next((a for a in rest if not a.startswith('--')), 'small')

# Suppress HuggingFace symlink warning
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

try:
    from faster_whisper import WhisperModel
except ImportError:
    print(json.dumps({"error": "faster-whisper not installed. Run: pip install faster-whisper"}))
    sys.exit(1)

model = WhisperModel(model_size, device="cpu", compute_type="int8")

segments_list, info = model.transcribe(audio_path, beam_size=5)

texts = []
segment_records = []
total = info.duration if info.duration else 1.0
last_pct = 0

for seg in segments_list:
    text = seg.text.strip()
    texts.append(text)
    if want_segments:
        segment_records.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})
    pct = min(99, int(seg.end / total * 100))
    if pct > last_pct:
        print(f"PROGRESS:{pct}", flush=True)
        last_pct = pct

print("PROGRESS:100", flush=True)

result = {
    "text": " ".join(texts),
    "language": info.language,
    "duration_s": round(info.duration, 1),
}
if want_segments:
    result["segments"] = segment_records
print(json.dumps(result, ensure_ascii=False))
