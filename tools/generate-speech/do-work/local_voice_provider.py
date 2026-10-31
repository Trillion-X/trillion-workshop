#!/usr/bin/env python3
"""A provider command that needs no account: the voice program already on this computer.

It is the smallest real provider, for checking that the chain works end to end and as the shape a person's own
provider follows. A hosted voice service's caller is the same contract with a different command: it reads the request
and writes the answer, and nothing else about generate_speech.py changes.

  local_voice_provider.py --request-json REQUEST --output-json ANSWER

It runs the first program it finds from the request's options.engines (default: say, espeak-ng, espeak), with the
voice named by options.voice when there is one, and writes a 16-bit WAV. The audio is returned inline as a data: URL;
generate_speech.py writes it to a file. Standard library only. Exit 1 with a message on standard error when no
program is found or none made audio.
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave
from datetime import datetime, timezone

DEFAULT_ENGINES = ["say", "espeak-ng", "espeak"]
# say is quick or hung (it waits on a per-user service that a detached process cannot reach); the others are slow only on long text.
TIMEOUT_SECONDS = {"say": 20}
FALLBACK_TIMEOUT_SECONDS = 240


def command_for(engine, text, voice, out_path):
    if engine == "say":
        return ["say", *(["-v", voice] if voice else []), "--file-format=WAVE", "--data-format=LEI16@22050", "-o", out_path, text]
    return [engine, *(["-v", voice] if voice else []), "-w", out_path, text]


def speak(engines, text, voice, out_path):
    """The name of the program that made the audio at out_path, and what went wrong for each that did not."""
    problems = []
    for engine in engines:
        if not shutil.which(engine):
            problems.append(f"{engine}: not found")
            continue
        try:
            subprocess.run(command_for(engine, text, voice, out_path), check=True, capture_output=True,
                           timeout=TIMEOUT_SECONDS.get(engine, FALLBACK_TIMEOUT_SECONDS))
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            detail = getattr(error, "stderr", b"") or b""
            problems.append(f"{engine}: {detail.decode('utf-8', 'replace')[-300:].strip() or error}")
            continue
        if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            return engine, problems
        problems.append(f"{engine}: made no audio")
    return None, problems


def duration_ms(path):
    try:
        with wave.open(path, "rb") as audio:
            return round(audio.getnframes() * 1000 / audio.getframerate())
    except (wave.Error, EOFError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()
    with open(args.request_json, encoding="utf-8") as handle:
        request = json.load(handle)
    options = request.get("options") if isinstance(request.get("options"), dict) else {}
    engines = [str(name) for name in options.get("engines") or DEFAULT_ENGINES]
    voice = str(options.get("voice") or "")
    with tempfile.TemporaryDirectory() as folder:
        out_path = os.path.join(folder, "speech.wav")
        engine, problems = speak(engines, str(request.get("text") or ""), voice, out_path)
        if engine is None:
            print("no voice program made audio: " + "; ".join(problems), file=sys.stderr)
            return 1
        with open(out_path, "rb") as handle:
            data = handle.read()
        length = duration_ms(out_path)
    answer = {
        "provider_ref": f"local-voice:{engine}",
        "language": str(options.get("language") or "und"),
        "format": "audio/wav",
        "duration_ms": length,
        "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "output_artifact_refs": [{"src": "data:audio/wav;base64," + base64.b64encode(data).decode("ascii"), "media_type": "audio/wav", "role": "speech-audio"}],
    }
    with open(args.output_json, "w", encoding="utf-8") as handle:
        json.dump(answer, handle)
    return 0


if __name__ == "__main__":
    sys.exit(main())
