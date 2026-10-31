"""What a provider command's answer means: the image result, or an honest error.

Pure functions, no files and no clock. The provider command (a hosted model's caller or a local model's
program) makes the image and prints JSON describing it. Nothing here makes up an image: when the answer has
no image, the result is an error that says so.
"""

REFERENCE_KEYS = ("src", "url", "path")


def as_list(value):
    return value if isinstance(value, list) else []


def as_object(value):
    return value if isinstance(value, dict) else {}


def error_payload(request, code, message, details=None):
    payload = {
        "kind": "image-generation.error",
        "request_id": request.get("request_id"),
        "prompt": request.get("prompt"),
        "code": code,
        "message": message,
        "observed_at": request.get("requested_at"),
    }
    if details:
        payload["details"] = details
    return payload


def artifact_refs(value):
    """The images a provider reports: each names where it is (src, url or path)."""
    return [item for item in as_list(value)
            if isinstance(item, dict) and any(isinstance(item.get(key), str) and item.get(key) for key in REFERENCE_KEYS)]


def first_reference(refs):
    for ref in refs:
        for key in REFERENCE_KEYS:
            if isinstance(ref.get(key), str) and ref[key]:
                return ref[key]
    return None


def result_payload(request, answer):
    """One `image-generation.result` from the provider's answer, or an `image-generation.error` when it holds no image."""
    refs = artifact_refs(answer.get("output_artifact_refs"))
    if not refs:
        return error_payload(
            request,
            "image_generation_command_output_missing_artifacts",
            "The provider command answered without an image. Its output_artifact_refs must name each image by src, url or path.",
            {"available_keys": sorted(str(key) for key in answer.keys())},
        )
    options = as_object(request.get("options"))
    return {
        "kind": "image-generation.result",
        "request_id": request.get("request_id"),
        "prompt": request.get("prompt"),
        "provider_ref": answer.get("provider_ref") or options.get("provider_ref"),
        "format": str(answer.get("format") or options.get("format") or "image/unknown"),
        "output_artifact_refs": refs,
        "src": first_reference(refs),
        "completed_at": str(answer.get("completed_at") or request.get("requested_at") or ""),
    }


def no_provider_payload(request):
    """The honest answer when no provider command was given."""
    return error_payload(
        request,
        "image_provider_missing",
        "Give a provider command (a hosted model's caller or a local model's program) to make images. Nothing was generated.",
    )
