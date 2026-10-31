#!/usr/bin/env python3
"""Make speech from text with a provider command the person names, and keep what it made.

  generate_speech.py --request request.json --out FOLDER

request.json:
  {
    "request_id": "any stable text",
    "text": "what to say",
    "voice_profile_ref": "the person's own name for the voice (kept as it is, may be absent)",
    "provider": {                       # absent: the honest "no provider" answer, nothing is made
      "argv": ["program", "--request-json", "{request}", "--output-json", "{output}"],
      "env_names": ["NAMES_OF_VARIABLES_THE_PROGRAM_NEEDS"],   # copied from this computer's environment, never from the request
      "timeout_seconds": 600
    },
    "options": {...},                   # voice, language, format and the like: handed to the provider as they are
    "requested_at": "when it was asked"
  }

The provider is any program: a hosted voice service's caller or a local voice program. It reads {request} (this
request's JSON) and writes {output}: {"output_artifact_refs": [{"src": "data:audio/wav;base64,...", "media_type": ...} |
{"url": ...} | {"path": ...}], "provider_ref", "language", "format", "duration_ms", "completed_at"}. Audio it returns
inline is written to a file in FOLDER. The last line printed is {"result": ...}: a speech-generation.result, or a
speech-generation.error that says what is missing. Exit 0 for a result, 2 for an error.
"""
import argparse
import base64
import json
import mimetypes
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))
from speech_records import as_list, as_object, error_payload, no_provider_payload, no_text_payload, result_payload  # noqa: E402

DEFAULT_TIMEOUT_SECONDS = 600
DATA_URL = re.compile(r"^data:([^;,]+)(;base64)?,(.*)$", re.DOTALL)
# What the system's table of media types calls these is not always what a person expects.
EXTENSIONS = {"audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/ogg": ".ogg"}


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def safe_name(text):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(text or "speech-request")).strip("_") or "speech-request"


def keep_inline_audio(answer, request, out_dir):
    """Write each audio file the provider returned inline to a file, and name that file in its place."""
    if not as_list(answer.get("output_artifact_refs")):
        return answer
    stem = safe_name(request.get("request_id"))
    kept = []
    for index, ref in enumerate(as_list(answer.get("output_artifact_refs"))):
        if not isinstance(ref, dict):
            continue
        match = DATA_URL.match(ref.get("src") or "")
        if not match:
            kept.append(ref)
            continue
        media_type, is_base64, body = match.groups()
        data = base64.b64decode(body) if is_base64 else body.encode("utf-8")
        suffix = EXTENSIONS.get(media_type) or mimetypes.guess_extension(media_type) or ".bin"
        name = f"{stem}-{index + 1}{suffix}"
        with open(os.path.join(out_dir, name), "wb") as handle:
            handle.write(data)
        rest = {key: value for key, value in ref.items() if key != "src"}
        kept.append({**rest, "path": name, "media_type": media_type, "byte_length": len(data)})
    return {**answer, "output_artifact_refs": kept}


def run_provider(request, provider, out_dir):
    work = os.path.join(out_dir, ".provider-work")
    os.makedirs(work, exist_ok=True)
    request_file = os.path.join(work, "request.json")
    output_file = os.path.join(work, "output.json")
    with open(request_file, "w", encoding="utf-8") as handle:
        json.dump(request, handle, ensure_ascii=False)
    argv = [str(part).replace("{request}", request_file).replace("{output}", output_file) for part in as_list(provider.get("argv"))]
    env = {name: os.environ[name] for name in ["PATH", "HOME", "LANG"] + [str(n) for n in as_list(provider.get("env_names"))] if name in os.environ}
    try:
        done = subprocess.run(argv, env=env, capture_output=True, text=True,
                              timeout=provider.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS)
    except FileNotFoundError:
        return None, error_payload(request, "speech_provider_not_found", "The provider command could not be started.", {"program": argv[0]})
    except subprocess.TimeoutExpired:
        return None, error_payload(request, "speech_provider_timed_out", "The provider command did not finish in time.")
    if done.returncode != 0 or not os.path.exists(output_file):
        return None, error_payload(request, "speech_provider_failed", "The provider command did not write an answer.",
                                   {"exit_code": done.returncode, "stderr": done.stderr[-2000:]})
    try:
        return as_object(read_json(output_file)), None
    except ValueError:
        return None, error_payload(request, "speech_provider_answer_unreadable", "The provider command's answer is not JSON.")


def generate(request, out_dir):
    if not str(request.get("text") or "").strip():
        return no_text_payload(request)
    provider = as_object(request.get("provider"))
    if not as_list(provider.get("argv")):
        return no_provider_payload(request)
    os.makedirs(out_dir, exist_ok=True)
    answer, failure = run_provider({k: v for k, v in request.items() if k != "provider"}, provider, out_dir)
    if failure:
        return failure
    return result_payload(request, keep_inline_audio(answer, request, out_dir))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--request", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    request = as_object(read_json(args.request))
    payload = generate(request, args.out)
    print(json.dumps({"result": payload}, ensure_ascii=False))
    return 2 if payload["kind"] == "speech-generation.error" else 0


if __name__ == "__main__":
    sys.exit(main())
