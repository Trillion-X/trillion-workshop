#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WHISPER_CLI_CANDIDATES = (
    "whisper-cli",
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
    "/opt/local/bin/whisper-cli",
)

FFMPEG_CANDIDATES = (
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/local/bin/ffmpeg",
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_json(path: str, value: dict[str, Any]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))


def error_output(request_id: str, code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "kind": "audio-transcription.error",
        "role": "errors",
        "request_id": request_id,
        "code": code,
        "message": message,
        "observed_at": now(),
    }
    if details:
        payload["details"] = details
    return {"records": [{"address": f"package::audio-transcription::error::{request_id}", "path": ["audio-transcription", "content-media-evidence"], "payload": payload}]}


def find_executable(env_key: str, candidates: tuple[str, ...]) -> tuple[str | None, list[str]]:
    configured = os.environ.get(env_key)
    search = ([configured] if configured else []) + list(candidates)
    checked: list[str] = []
    for candidate in search:
        if not candidate:
            continue
        checked.append(candidate)
        executable = shutil.which(candidate) if os.path.sep not in candidate else candidate
        if executable and Path(executable).exists():
            return executable, checked
    return None, checked


def timestamp_seconds(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        return float(parts[0])
    except (TypeError, ValueError):
        return None


def segment_seconds(item: dict[str, Any], key: str) -> float:
    offsets = item.get("offsets")
    if isinstance(offsets, dict) and isinstance(offsets.get(key), (int, float)):
        return float(offsets[key]) / 1000.0
    timestamps = item.get("timestamps")
    if isinstance(timestamps, dict):
        parsed = timestamp_seconds(timestamps.get("from" if key == "from" else "to"))
        if parsed is not None:
            return parsed
    parsed = timestamp_seconds(item.get("start" if key == "from" else "end"))
    return parsed if parsed is not None else 0.0


def words_from_segment(text: str, start: float, end: float) -> list[dict[str, Any]]:
    tokens = [token for token in text.strip().split() if token]
    if not tokens:
        return []
    duration = max(0.05, end - start)
    step = duration / len(tokens)
    return [{"t": token, "start": round(start + index * step, 3), "end": round(start + (index + 1) * step, 3)} for index, token in enumerate(tokens)]


def normalize_whisper_json(value: dict[str, Any], request_id: str) -> dict[str, Any]:
    raw_segments = value.get("transcription")
    if not isinstance(raw_segments, list):
        raw_segments = value.get("segments")
    segments: list[dict[str, Any]] = []
    words: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_segments if isinstance(raw_segments, list) else []):
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text") or "").strip()
        start = segment_seconds(raw, "from")
        end = segment_seconds(raw, "to")
        if end <= start:
            end = start + max(0.35, len(text.split()) * 0.24)
        segments.append({"segment_index": index, "start": start, "end": end, "text": text})
        token_rows = raw.get("tokens")
        if isinstance(token_rows, list):
            for token in token_rows:
                if isinstance(token, dict) and token.get("text"):
                    token_start = timestamp_seconds(token.get("start"))
                    token_end = timestamp_seconds(token.get("end"))
                    has_token_timing = token_start is not None and token_end is not None and token_end >= token_start
                    if not has_token_timing:
                        token_start = start
                        token_end = max(start + 0.05, end)
                    words.append({
                        "t": str(token.get("text")).strip(),
                        "start": token_start,
                        "end": token_end,
                        "timing_source": "engine_token_timestamps" if has_token_timing else "segment_bounds_fallback",
                    })
        if not token_rows:
            words.extend({**word, "timing_source": "segment_uniform_estimate"} for word in words_from_segment(text, start, end))
    full_text = " ".join(segment["text"] for segment in segments).strip()
    result = value.get("result")
    language = result.get("language") if isinstance(result, dict) else None
    return {
        "command_run_id": f"package::audio-transcription::command-run-request::{request_id}",
        "language": str(language or "und"),
        "full_text": full_text,
        "segments": segments,
        "words": words,
        "completed_at": now(),
    }


def ensure_model(model_path: Path, model_url: str) -> str | None:
    if model_path.exists() and model_path.stat().st_size > 0:
        return None
    model_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = model_path.with_suffix(model_path.suffix + ".download")
    try:
        with urllib.request.urlopen(model_url, timeout=60) as response:
            with open(tmp_path, "wb") as handle:
                shutil.copyfileobj(response, handle)
        tmp_path.replace(model_path)
        return None
    except Exception as exc:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
        return str(exc)


def normalize_audio(audio_path: str, request_id: str, output_path: str) -> str | None:
    """One input path for every container/codec the source may carry.

    whisper-cli reads only WAV. Browser recordings arrive as webm/opus,
    imports arrive as anything ffmpeg understands, and video sources carry
    their audio track inside the container. Decoding everything through one
    ffmpeg resample (16 kHz mono WAV) makes the source media type irrelevant
    to the transcriber. Returns the path to transcribe, or None after writing
    an honest error record.
    """
    ffmpeg, checked_paths = find_executable("BITFIELD_FFMPEG_PATH", FFMPEG_CANDIDATES)
    if not ffmpeg:
        write_json(output_path, error_output(
            request_id,
            "audio_decoder_missing",
            "No audio decoder was found, so this recording's format cannot be read.",
            {"checked_paths": checked_paths, "process_path": os.environ.get("PATH", "")},
        ))
        return None
    converted = str(Path(audio_path).parent / "normalized-for-transcription.wav")
    command = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-i", audio_path, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", converted]
    started = time.time()
    completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if completed.returncode != 0 or not Path(converted).exists() or Path(converted).stat().st_size == 0:
        write_json(output_path, error_output(
            request_id,
            "audio_decode_failed",
            "The recording's audio could not be decoded for transcription.",
            {"exit_code": completed.returncode, "stderr": completed.stderr[-4000:], "duration_ms": int((time.time() - started) * 1000)},
        ))
        return None
    return converted


def run_whisper(audio_path: str, request_id: str, output_path: str) -> int:
    whisper, checked_paths = find_executable("BITFIELD_WHISPER_CLI_PATH", WHISPER_CLI_CANDIDATES)
    if not whisper:
        write_json(output_path, error_output(
            request_id,
            "transcription_provider_missing",
            "No local Whisper executable was found by the process runner.",
            {"checked_paths": checked_paths, "process_path": os.environ.get("PATH", "")},
        ))
        return 0
    audio_path = normalize_audio(audio_path, request_id, output_path)
    if not audio_path:
        return 0
    model_name = os.environ.get("BITFIELD_WHISPER_MODEL", "${DEFAULT_WHISPER_MODEL}")
    model_path = Path(os.environ.get("BITFIELD_WHISPER_MODEL_PATH", str(Path.home() / ".bitfield/runtime-kit/models/whisper" / model_name)))
    model_url = os.environ.get("BITFIELD_WHISPER_MODEL_URL", "${DEFAULT_WHISPER_MODEL_URL}")
    model_error = ensure_model(model_path, model_url)
    if model_error:
        write_json(output_path, error_output(request_id, "transcription_model_unavailable", "Whisper model could not be downloaded.", {"model_path": str(model_path), "model_url": model_url, "error": model_error}))
        return 0
    out_base = str(Path(output_path).with_suffix(""))
    command = [whisper, "-m", str(model_path), "-f", audio_path, "-oj", "-ojf", "-of", out_base, "-np"]
    started = time.time()
    completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    json_path = Path(out_base + ".json")
    if completed.returncode != 0 or not json_path.exists():
        write_json(output_path, error_output(request_id, "transcription_command_failed", "whisper-cli did not produce transcription JSON.", {"exit_code": completed.returncode, "stdout": completed.stdout[-2000:], "stderr": completed.stderr[-4000:], "duration_ms": int((time.time() - started) * 1000)}))
        return 0
    with open(json_path, "r", encoding="utf-8") as handle:
        write_json(output_path, normalize_whisper_json(json.load(handle), request_id))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: transcribe.py <audio-path> <request-id> <output-json>")
    raise SystemExit(run_whisper(sys.argv[1], sys.argv[2], sys.argv[3]))
