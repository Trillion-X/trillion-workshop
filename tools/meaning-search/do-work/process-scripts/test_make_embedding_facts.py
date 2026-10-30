#!/usr/bin/env python3
"""Unit + adversarial tests for make-embedding-facts-from-command-output.py."""

from __future__ import annotations

import importlib.util
import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
SCRIPT = HERE / "make-embedding-facts-from-command-output.py"

spec = importlib.util.spec_from_file_location("make_embedding_facts", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

REQUEST = {"index_id": "default-text", "content_address": "record::note::abc",
           "content_text": "hello world", "at": "2026-07-18T00:00:00Z",
           "canonical_address": "record::note::abc", "canonical_revision": "7",
           "canonical_payload_hash": "sha256:canonical", "source_snapshot_ref": "1f:snapshot",
           "search_metadata": {"owner_target": "slot::workflow", "schema_ref": "record::note::abc",
                               "schema_digest": "sha256:canonical",
                               "authority_provenance_ref": "authority:test"}}
COMMAND_OUTPUT = {"vector": [0.0123, -0.987],
                  "provenance": {"model_id": "test-embedder", "model_version": "1.0"}}


def test_exact_rows() -> None:
    rows = mod.fact_rows(dict(REQUEST), dict(COMMAND_OUTPUT))
    assert rows == [
        {"address": "entity|record::note::abc", "path": ["current-item", "published-record"],
         "payload": {"table": "entity", "id": "record::note::abc"}},
        {"address": "entity_types|record::note::abc|type:semantic-indexed",
         "path": ["current-item", "published-record"],
         "payload": {"table": "entity_types", "entity_id": "record::note::abc",
                     "type_id": "type:semantic-indexed"}},
        {"address": "type_properties|type:semantic-indexed|prop:semantic-embedding:default-text",
         "path": ["current-item", "published-record"],
         "payload": {"table": "type_properties", "type_id": "type:semantic-indexed",
                     "property_id": "prop:semantic-embedding:default-text"}},
        {"address": "attribute_fact|record::note::abc|prop:semantic-embedding:default-text|type:semantic-indexed",
         "path": ["current-item", "published-record"],
         "payload": {"table": "attribute_fact", "subject_id": "record::note::abc",
                     "property_id": "prop:semantic-embedding:default-text",
                     "type_id": "type:semantic-indexed", "value_json": "{\"vector\":[0.0123,-0.987],\"owner_target\":\"slot::workflow\",\"schema_ref\":\"record::note::abc\",\"schema_digest\":\"sha256:canonical\",\"authority_provenance_ref\":\"authority:test\",\"canonical_address\":\"record::note::abc\",\"canonical_revision\":\"7\",\"canonical_payload_hash\":\"sha256:canonical\",\"source_snapshot_ref\":\"1f:snapshot\"}"}},
        {"address": "attribute_fact|record::note::abc|prop:semantic-provenance:default-text|type:semantic-indexed",
         "path": ["current-item", "published-record"],
         "payload": {"table": "attribute_fact", "subject_id": "record::note::abc",
                     "property_id": "prop:semantic-provenance:default-text",
                     "type_id": "type:semantic-indexed",
                     "value_json": "{\"model_id\":\"test-embedder\",\"model_version\":\"1.0\",\"at\":\"2026-07-18T00:00:00Z\",\"owner_target\":\"slot::workflow\",\"schema_ref\":\"record::note::abc\",\"schema_digest\":\"sha256:canonical\",\"authority_provenance_ref\":\"authority:test\",\"canonical_address\":\"record::note::abc\",\"canonical_revision\":\"7\",\"canonical_payload_hash\":\"sha256:canonical\",\"source_snapshot_ref\":\"1f:snapshot\"}"}},
    ], rows


def expect_error(request, command_output, needle) -> None:
    try:
        mod.fact_rows(request, command_output)
    except ValueError as exc:
        assert needle in str(exc), (needle, str(exc))
        return
    raise AssertionError(f"expected ValueError containing {needle!r}")


def test_adversarial() -> None:
    expect_error({**REQUEST, "content_address": ""}, dict(COMMAND_OUTPUT), "content_address")
    r = dict(REQUEST); r.pop("index_id")
    expect_error(r, dict(COMMAND_OUTPUT), "index_id")
    expect_error(dict(REQUEST), {"provenance": COMMAND_OUTPUT["provenance"]}, "vector")
    expect_error(dict(REQUEST), {"vector": []}, "vector")
    expect_error(dict(REQUEST), {"vector": [0.1, "x"], "provenance": COMMAND_OUTPUT["provenance"]}, "numbers")
    expect_error(dict(REQUEST), {"vector": [0.1, True], "provenance": COMMAND_OUTPUT["provenance"]}, "numbers")
    expect_error(dict(REQUEST), {"vector": [0.1]}, "model_id")
    r = dict(REQUEST); r.pop("canonical_revision")
    expect_error(r, dict(COMMAND_OUTPUT), "canonical_revision")
    expect_error({**REQUEST, "source_snapshot_ref": ""}, dict(COMMAND_OUTPUT), "source_snapshot_ref")
    expect_error(
        {**REQUEST, "search_metadata": {"owner_target": "slot::workflow"}},
        dict(COMMAND_OUTPUT),
        "schema_ref",
    )
    # 'embedding' alias accepted
    rows = mod.fact_rows(dict(REQUEST), {"embedding": [1, 2], "model_id": "m", "model_version": "v"})
    assert json.loads(rows[3]["payload"]["value_json"])["vector"] == [1.0, 2.0]


def test_cli_end_to_end() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        req = Path(tmp) / "request.json"
        out = Path(tmp) / "command-output.json"
        rec = Path(tmp) / "records.json"
        req.write_text(json.dumps(REQUEST))
        out.write_text(json.dumps(COMMAND_OUTPUT))
        proc = subprocess.run([sys.executable, str(SCRIPT), "--request-json", str(req),
                               "--command-output-json", str(out), "--output-json", str(rec)],
                              capture_output=True, text=True)
        assert proc.returncode == 0, proc.stderr
        assert "[meaning-search] wrote 5 fact rows for record::note::abc" in proc.stdout
        rows = json.loads(rec.read_text())
        assert len(rows) == 5 and rows == mod.fact_rows(dict(REQUEST), dict(COMMAND_OUTPUT))
        # CLI failure path: missing descriptor fields must exit non-zero, no output rows
        bad = Path(tmp) / "bad.json"
        bad.write_text(json.dumps({"vector": [1]}))
        rec2 = Path(tmp) / "records2.json"
        proc2 = subprocess.run([sys.executable, str(SCRIPT), "--request-json", str(req),
                                "--command-output-json", str(bad), "--output-json", str(rec2)],
                               capture_output=True, text=True)
        assert proc2.returncode == 1 and "model_id" in proc2.stderr and not rec2.exists()


def test_vector_input_path() -> None:
    """Test that vector-input path (pre-computed vectors) works correctly.
    When a caller supplies a pre-computed vector (via content_vector_base64),
    the make-embedding-facts script should use it directly without requiring
    the embedding executor to run."""
    # Pre-computed vector supplied via the content_vector_base64 path
    # (in a real workflow, this comes from index-content's if_null fallback
    # when content_vector_base64 is present in the index-content input)
    command_output_from_precomputed = {
        "vector": [0.707, -0.707],  # a pre-computed normalized vector
        "model_id": "clip-text-encoder",
        "model_version": "openai"
    }
    rows = mod.fact_rows(dict(REQUEST), command_output_from_precomputed)
    # Verify the embedding fact contains the supplied vector, not a default
    embedding_fact = [r for r in rows if r["payload"].get("property_id") == "prop:semantic-embedding:default-text"
                      and r["payload"].get("table") == "attribute_fact"][0]
    assert json.loads(embedding_fact["payload"]["value_json"])["vector"] == [0.707, -0.707]
    # Verify provenance records the model that produced it
    provenance_fact = [r for r in rows if r["payload"].get("property_id") == "prop:semantic-provenance:default-text"][0]
    prov_json = json.loads(provenance_fact["payload"]["value_json"])
    assert prov_json["model_id"] == "clip-text-encoder"
    assert prov_json["model_version"] == "openai"


def test_precomputed_vector_uses_validated_descriptor_provenance() -> None:
    rows = mod.fact_rows(
        dict(REQUEST),
        {"vector": [0.25, -0.25]},
        {"model_id": "descriptor-owned-model", "model_version": "2026-07"},
    )
    provenance_fact = [r for r in rows if r["payload"].get("property_id") == "prop:semantic-provenance:default-text"][0]
    provenance = json.loads(provenance_fact["payload"]["value_json"])
    assert provenance["model_id"] == "descriptor-owned-model"
    assert provenance["model_version"] == "2026-07"


def test_batch_rows_and_vectors_are_exact_and_coalesced() -> None:
    second = {
        **REQUEST,
        "content_address": "record::note::def",
        "canonical_address": "record::note::def",
    }
    vectors, rows = mod.batch_fact_rows(
        {"upserts": [dict(REQUEST), second]},
        {
            "vectors": {
                "record::note::abc": [1, 2],
                "record::note::def": [3.5, 4],
            },
            "provenance": COMMAND_OUTPUT["provenance"],
        },
        {},
    )
    assert vectors == {
        "record::note::abc": [1.0, 2.0],
        "record::note::def": [3.5, 4.0],
    }
    assert len(rows) == 9
    assert (
        sum(
            row["address"]
            == "type_properties|type:semantic-indexed|prop:semantic-embedding:default-text"
            for row in rows
        )
        == 1
    )


def test_batch_precomputed_vectors_and_exact_provider_membership() -> None:
    encoded = base64.b64encode(json.dumps({"vector": [5, 6]}).encode()).decode()
    request = {**REQUEST, "content_vector_base64": encoded}
    vectors, rows = mod.batch_fact_rows(
        {"upserts": [request]},
        {"vectors": {}},
        {"model_id": "precomputed", "model_version": "1"},
    )
    assert vectors[REQUEST["content_address"]] == [5.0, 6.0]
    assert json.loads(rows[-1]["payload"]["value_json"])["model_id"] == "precomputed"

    with unittest.TestCase().assertRaisesRegex(ValueError, "exactly match"):
        mod.batch_fact_rows(
            {"upserts": [dict(REQUEST)]},
            {"vectors": {"wrong": [1, 2]}},
            {"model_id": "m"},
        )


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    for name, candidate in sorted(globals().items()):
        if name.startswith("test_") and callable(candidate):
            suite.addTest(unittest.FunctionTestCase(candidate))
    return suite


if __name__ == "__main__":
    test_exact_rows()
    test_adversarial()
    test_cli_end_to_end()
    print("test_make_embedding_facts: all tests passed")
