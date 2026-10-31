"""What a provider command's answer means: the speech result, or an honest error.

Pure functions, no files and no clock. The provider command (a hosted voice service's caller or a local voice
program) makes the audio and prints JSON describing it. Nothing here makes up audio: when the answer has no audio,
the result is an error that says so.
"""

REFERENCE_KEYS = ("src", "url", "path")


def as_list(value):
    return value if isinstance(value, list) else []


def as_object(value):
    return value if isinstance(value, dict) else {}


def error_payload(request, code, message, details=None):
    payload = {
        "kind": "speech-generation.error",
        "request_id": request.get("request_id"),
        "voice_profile_ref": request.get("voice_profile_ref"),
        "code": code,
        "message": message,
        "observed_at": request.get("requested_at"),
    }
    if details:
        payload["details"] = details
    return payload


def artifact_refs(value):
    """The audio a provider reports: each names where it is (src, url or path)."""
    return [item for item in as_list(value)
            if isinstance(item, dict) and any(isinstance(item.get(key), str) and item.get(key) for key in REFERENCE_KEYS)]


def first_reference(refs):
    for ref in refs:
        for key in REFERENCE_KEYS:
            if isinstance(ref.get(key), str) and ref[key]:
                return ref[key]
    return None


def result_payload(request, answer):
    """One `speech-generation.result` from the provider's answer, or a `speech-generation.error` when it holds no audio."""
    refs = artifact_refs(answer.get("output_artifact_refs"))
    if not refs:
        return error_payload(
            request,
            "speech_generation_command_output_missing_artifacts",
            "The provider command answered without audio. Its output_artifact_refs must name each audio file by src, url or path.",
            {"available_keys": sorted(str(key) for key in answer.keys())},
        )
    options = as_object(request.get("options"))
    return {
        "kind": "speech-generation.result",
        "request_id": request.get("request_id"),
        "voice_profile_ref": request.get("voice_profile_ref"),
        "provider_ref": answer.get("provider_ref") or options.get("provider_ref"),
        "language": str(answer.get("language") or options.get("language") or "und"),
        "format": str(answer.get("format") or options.get("format") or "audio/unknown"),
        "duration_ms": answer.get("duration_ms"),
        "output_artifact_refs": refs,
        "src": first_reference(refs),
        "completed_at": str(answer.get("completed_at") or request.get("requested_at") or ""),
    }


def no_text_payload(request):
    """The honest answer when there is nothing to say."""
    return error_payload(request, "speech_generation_empty_text", "Speech generation needs non-empty text. Nothing was generated.")


def no_provider_payload(request):
    """The honest answer when no provider command was given."""
    return error_payload(
        request,
        "speech_provider_missing",
        "Give a provider command (a voice service's caller or a local voice program) to make speech. Nothing was generated.",
    )
