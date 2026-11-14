import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "do-work/process-scripts/bind-media-source.py"
SPEC = importlib.util.spec_from_file_location("bind_media_source", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def request():
    return {
        "observation": {
            "source_identity_ref": "source-identity:1f:a",
            "source_revision_ref": "1f:b",
            "correlation_ref": "observation-batch:1f:c",
            "source_authorization": {"status": "authorized", "authorization_scope_ref": "scope:a"},
        },
        "locator": {"availability": "available", "locator_ref": "locator:1f:b", "target": "local.files", "request": {"operation": "read_range", "path": "/authorized/source"}, "byte_length": 100},
        "probe": {"duration_seconds": 10.0, "media_type": "video/mp4"},
        "time_range": {"start": 1.0, "end": 9.0},
        "clock": {"basis": "container-timeline", "uncertainty_seconds": 0.001},
        "sidecars": [{"role_ref": "transcript", "source_revision_ref": "1f:d", "locator_ref": "live-namespace::locator::1f:d"}],
    }


def test_provider_neutral_binding_supplies_exact_production_refs():
    result = MODULE.bind(request())
    assert result["state"] == "usable"
    assert result["production_input"]["source_revision_ref"] == "1f:b"
    assert result["production_input"]["correlation_ref"] == "observation-batch:1f:c"
    assert result["production_input"]["time_range"] == {"start": 1.0, "end": 9.0}
    assert result["production_input"]["sidecars"][0]["role_ref"] == "transcript"


def test_missing_origin_cancellation_and_wrong_time_fail_truthfully():
    missing = request(); missing["locator"] = {"availability": "missing", "reason": "selected drive is unavailable"}
    assert MODULE.bind(missing)["code"] == "origin-unavailable"
    cancelled = request(); cancelled["cancelled"] = True
    assert MODULE.bind(cancelled)["code"] == "cancelled"
    wrong = request(); wrong["time_range"] = {"start": 9, "end": 11}
    assert MODULE.bind(wrong)["code"] == "invalid-time-range"
    unknown_clock = request(); unknown_clock["clock"] = {"basis": "guessed"}
    assert MODULE.bind(unknown_clock)["code"] == "unknown-clock"


def test_provider_names_cannot_change_consumer_shape():
    first = MODULE.bind(request())["production_input"]
    other = request(); other["observation"]["source_provenance"] = {"capture_device": "unrelated-provider"}
    assert MODULE.bind(other)["production_input"] == first
