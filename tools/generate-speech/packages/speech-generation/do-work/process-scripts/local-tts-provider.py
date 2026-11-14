#!/usr/bin/env python3
"""Local TTS speech provider for the speech-generation speech_command seam.

Physics: turn request text into a real audio artifact using ONLY local OS
processes (macOS `say` -> `ffmpeg`), then self-address the audio bytes with the
platform's canonical multihash (`1f:` + blake3-256 hex, == process-engine
`Multihash::hash(bytes).to_code_hex()`), and emit a command-output.json the
speech-generation record-maker consumes (output_artifact_refs with multihash).

The engine stores this script's `addressed_chunks` audio output in CAS under the
SAME hash, so the emitted multihash resolves for downstream compose. No external
provider, no credential — the WASM/brain orchestrates local OS executors.

Usage:
  local-tts-provider.py <request-json> <command-output-json> <audio-out-path>

<request-json>          mounted request with {text, options:{language,format,voice}}
<command-output-json>   this script writes the record-maker input here (outputs[0])
<audio-out-path>        this script writes the audio bytes here (addressed_chunks)
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _blake3_hex(data: bytes) -> str:
    """BLAKE3-256 hex of `data`, via whichever blake3 implementation this platform has.

    Prefers the python `blake3` module (present on the macOS dev instance); falls back to
    the `b3sum` CLI (present on the Fly Debian image — `python3-blake3` is not packaged in
    bookworm). L089: the hashing backend is discovered at runtime, not branched per env.
    """
    try:
        import blake3  # type: ignore
        return blake3.blake3(data).hexdigest()
    except ImportError:
        out = subprocess.run(
            ["b3sum", "--no-names"], input=data, capture_output=True, check=True, timeout=60
        )
        return out.stdout.decode().strip().split()[0]


def code_hex(data: bytes) -> str:
    # CSSOT parity with bitfield_crypto::Multihash::hash(bytes).to_code_hex()
    # == format!("{:x}:{}", BLAKE3_CODE=0x1f, hex(blake3_256(bytes)))
    return "1f:" + _blake3_hex(data)


def read_request(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    return value if isinstance(value, dict) else {}


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit(
            "usage: local-tts-provider.py <request-json> <command-output-json> <audio-out-path>"
        )
    request_path, command_output_path, audio_out_path = sys.argv[1:4]
    request = read_request(request_path)
    options = request.get("options") if isinstance(request.get("options"), dict) else {}

    text = str(request.get("text") or "").strip()
    if not text:
        # Fail closed with a machine-readable error record (parser passes records through).
        _write_error(command_output_path, request, "speech_generation_empty_text",
                     "Speech generation requires non-empty text.")
        return 0

    voice = str(options.get("voice") or "Samantha")
    fmt = str(options.get("format") or "audio/mpeg")
    language = str(options.get("language") or "en")

    workdir = Path(command_output_path).parent

    # 1) Local TTS via whichever real OS speech synthesizer THIS platform provides —
    #    macOS `say` (-> AIFF) or Linux `espeak-ng`/`espeak` (-> WAV). Each is a real
    #    local OS process (no network, no credentials). The environment is DATA the
    #    handler PROBES at runtime (L089): the SAME voice-profile speech_command DATA
    #    record runs unchanged on the macOS dev instance AND the Fly Linux production
    #    VM — zero per-environment code branch. ffmpeg transcodes either source format.
    source_path, tts_engine = _synthesize_source(text, voice, workdir)
    if source_path is None:
        _write_error(command_output_path, request, "speech_generation_tts_failed",
                     "No local TTS engine available (tried: say, espeak-ng, espeak).",
                     {"detail": tts_engine})
        return 0

    # 2) Transcode source audio -> requested format via ffmpeg (mp3 default = universally composable).
    ext, ffmpeg_args = _format_target(fmt)
    audio_path = Path(audio_out_path)
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(source_path), *ffmpeg_args, str(audio_path)],
            check=True, capture_output=True, timeout=240,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as exc:
        detail = getattr(exc, "stderr", b"")
        _write_error(command_output_path, request, "speech_generation_transcode_failed",
                     f"ffmpeg transcode failed: {exc}", {"stderr": _as_text(detail)})
        return 0

    audio_bytes = audio_path.read_bytes()
    multihash = code_hex(audio_bytes)
    duration_ms = _probe_duration_ms(audio_path)

    command_output = {
        "language": language,
        "format": fmt,
        "duration_ms": duration_ms,
        "completed_at": now(),
        "output_artifact_refs": [
            {
                "multihash": multihash,
                "cas_address": multihash,
                "byte_length": len(audio_bytes),
                "media_type": fmt,
                "role": "speech-audio",
            }
        ],
    }
    _write_json(command_output_path, command_output)
    return 0


def _synthesize_source(text: str, voice: str, workdir: Path) -> tuple[Path | None, str]:
    """Run the first available local TTS engine; return (source_audio_path, engine_name).

    Order: macOS `say` (-> AIFF), then Linux `espeak-ng`/`espeak` (-> WAV). Each is a real
    local OS process (no network, no credentials). The platform is DISCOVERED at runtime via
    `shutil.which`, so a single speech_command DATA descriptor is portable across the macOS
    dev instance and the Fly Linux production VM (L089 — environment is data, not a branch).
    Returns (None, <last_error>) if no engine produced audio.
    """
    from shutil import which

    aiff_path = workdir / "speech-source.aiff"
    wav_path = workdir / "speech-source.wav"
    # (engine, argv, out_path, timeout_s). `say` gets a SHORT timeout: it either
    # responds in a couple seconds or it is hung (in a detached/sandboxed process
    # macOS `say` blocks reaching the per-user speech-synthesis service — it can
    # never complete there). A short timeout fails fast to espeak-ng instead of
    # stalling the whole voice step for minutes. When `say` works (GUI session) it
    # is well under this bound, so audio quality is unaffected.
    attempts: list[tuple[str, list[str], Path, int]] = []
    if which("say"):
        # macOS: honor the requested named voice (e.g. "Samantha").
        attempts.append(("say", ["say", "-v", voice, "-o", str(aiff_path), text], aiff_path, 20))
    for espeak in ("espeak-ng", "espeak"):
        if which(espeak):
            # espeak voice ids differ from macOS names; use the language default voice.
            attempts.append((espeak, [espeak, "-w", str(wav_path), text], wav_path, 240))

    last = "no local TTS engine found on PATH"
    for engine_name, argv, out_path, timeout_s in attempts:
        try:
            subprocess.run(argv, check=True, capture_output=True, timeout=timeout_s)
            if out_path.exists() and out_path.stat().st_size > 0:
                return out_path, engine_name
            last = f"{engine_name}: produced no audio"
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as exc:
            last = f"{engine_name}: {_as_text(getattr(exc, 'stderr', b'') or str(exc))}"
    return None, last


def _format_target(fmt: str) -> tuple[str, list[str]]:
    fmt = fmt.lower()
    if "wav" in fmt:
        return "wav", ["-acodec", "pcm_s16le", "-ar", "22050"]
    if "aac" in fmt or "m4a" in fmt or "mp4" in fmt:
        return "m4a", ["-acodec", "aac", "-b:a", "128k"]
    # default mp3
    return "mp3", ["-acodec", "libmp3lame", "-b:a", "128k"]


def _probe_duration_ms(path: Path) -> int | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            check=True, capture_output=True, timeout=30,
        )
        return int(round(float(out.stdout.decode().strip()) * 1000))
    except Exception:
        return None


def _as_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")[:2000]
    return str(value)[:2000]


def _write_error(path: str, request: dict[str, Any], code: str, message: str,
                 details: dict[str, Any] | None = None) -> None:
    rid = str(request.get("request_id") or "request")
    token = "".join(ch if ch.isalnum() or ch in "._:-" else "_" for ch in rid)
    payload: dict[str, Any] = {
        "kind": "speech-generation.error",
        "request_id": rid,
        "voice_profile_ref": request.get("voice_profile_ref"),
        "voice_profile_approval_ref": request.get("voice_profile_approval_ref"),
        "code": code,
        "message": message,
        "observed_at": request.get("requested_at") or now(),
    }
    if details:
        payload["details"] = details
    _write_json(path, {"records": [{
        "address": f"package::speech-generation::error::{token}",
        "path": ["current-item", "published-record"],
        "payload": payload,
    }]})


def _write_json(path: str, value: dict[str, Any]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    raise SystemExit(main())
