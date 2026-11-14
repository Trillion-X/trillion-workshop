#!/usr/bin/env python3

import importlib.util
import json
import pathlib
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "do-work/process-scripts/observe-content-sources.py"
SPEC = importlib.util.spec_from_file_location("observe_content_sources", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def capture_payload():
    # Intentionally contains shapes that are invalid as DOMSnapshot arrays. The
    # observed-content owner must preserve raw evidence, never learn or parse CDP.
    return {
        "schema": "browsing-surface-provider.spatial-source-capture.response",
        "captured_at": "2026-09-01T00:00:00.000Z",
        "source": {"url": "https://example.test", "selected_backend_node_id": 9},
        "snapshot": {"strings": ["DIV"], "documents": [{"nodes": {"parentIndex": "opaque-to-ledger"}}]},
        "matched_styles": [{"backend_node_id": 9, "status": "captured", "styles": {}}],
        "resources": [{"url": "https://example.test/missing.png", "status": "error"}],
        "screenshot": {"format": "png", "data_base64": "cG5n"},
    }


class SpatialCaptureRawEvidenceAdmissionTest(unittest.TestCase):
    def validate(self, batch):
        with tempfile.TemporaryDirectory() as directory:
            batch_path = pathlib.Path(directory) / "batch.json"
            output_path = pathlib.Path(directory) / "result.json"
            batch_path.write_text(json.dumps(batch), encoding="utf-8")
            MODULE.mode_admit_validate(str(batch_path), str(output_path))
            return json.loads(output_path.read_text(encoding="utf-8"))

    def test_capture_payload_is_admitted_byte_for_byte_without_dom_parsing(self):
        payload = capture_payload()
        revision = "sha256:" + "a" * 64
        scope = "source-authorization:sha256:" + "b" * 64
        observation = {
            "source_ref": "source:browser-surface",
            "native_ref": "surface:one/capture:one",
            "cursor": {"kind": "capture-identity", "value": "capture:one"},
            "observed_at": "2026-09-01T00:00:00.000Z",
            "content_multihash": revision,
            "source_identity_ref": "source-identity:sha256:" + "c" * 64,
            "source_revision_ref": revision,
            "correlation_ref": "batch:capture:one",
            "source_authorization": {"status": "authorized", "access_mode": "read-only", "authorization_scope_ref": scope},
            "source_provenance": {"source_ref": "source:browser-surface", "native_ref": "surface:one/capture:one"},
            "payload": payload,
        }
        result = self.validate({
            "batch_ref": "batch:capture:one",
            "source_ref": "source:browser-surface",
            "authorization_scope_ref": scope,
            "observations": [observation],
        })
        self.assertNotIn("rejection", result)
        self.assertEqual(result["accepted"], [observation])
        self.assertEqual(result["accepted"][0]["payload"], payload)

    def test_foreign_scope_and_revoked_source_fail_closed(self):
        revision = "sha256:" + "a" * 64
        observation = {
            "source_ref": "source:private",
            "native_ref": "native:one",
            "cursor": {"kind": "revision", "value": revision},
            "observed_at": "2026-09-01T00:00:00.000Z",
            "content_multihash": revision,
            "source_identity_ref": "source-identity:sha256:" + "c" * 64,
            "source_revision_ref": revision,
            "correlation_ref": "batch:private",
            "source_authorization": {"status": "revoked", "access_mode": "read-only", "authorization_scope_ref": "scope:tenant-b"},
            "source_provenance": {"source_ref": "source:private", "native_ref": "native:one"},
            "payload": {"private": True},
        }
        result = self.validate({
            "batch_ref": "batch:private",
            "source_ref": "source:private",
            "authorization_scope_ref": "scope:tenant-a",
            "observations": [observation],
        })
        self.assertEqual(result["accepted"], [])
        paths = [item["violation_path"] for item in result["rejection"]["violations"]]
        self.assertIn("observations[0].source_authorization.status", paths)

    def test_batch_cannot_relabel_an_observation_from_another_source(self):
        revision = "1f:" + "a" * 64
        observation = {
            "source_ref": "source:other", "native_ref": "item:one",
            "cursor": {"kind": "item", "value": "one"},
            "observed_at": "2026-09-24T00:00:00Z",
            "content_multihash": revision, "source_revision_ref": revision,
            "source_identity_ref": "source-identity:one", "correlation_ref": "batch:one",
            "source_authorization": {"status": "authorized", "authorization_scope_ref": "scope:one"},
            "source_provenance": {"source_ref": "source:other", "native_ref": "item:one"},
            "payload": {"text": "A public question?"},
        }
        result = self.validate({"batch_ref": "batch:one", "source_ref": "source:claimed",
                                "authorization_scope_ref": "scope:one", "observations": [observation]})
        self.assertEqual(result["accepted"], [])
        self.assertEqual(result["rejection"]["violations"][0]["violation_path"], "observations[0].source_ref")

    def test_native_anchor_must_match_provenance(self):
        revision = "1f:" + "a" * 64
        observation = {
            "source_ref": "source:one", "native_ref": "item:one",
            "cursor": {"kind": "item", "value": "one"},
            "observed_at": "2026-09-24T00:00:00Z",
            "content_multihash": revision, "source_revision_ref": revision,
            "source_identity_ref": "source-identity:one", "correlation_ref": "batch:one",
            "source_authorization": {"status": "authorized", "authorization_scope_ref": "scope:one"},
            "source_provenance": {"source_ref": "source:one", "native_ref": "item:foreign"},
            "payload": {"text": "A public question?"},
        }
        result = self.validate({"batch_ref": "batch:one", "source_ref": "source:one",
                                "authorization_scope_ref": "scope:one", "observations": [observation]})
        self.assertEqual(result["accepted"], [])
        self.assertEqual(result["rejection"]["violations"][0]["violation_path"],
                         "observations[0].source_provenance.native_ref")

    def test_missing_content_identity_rejects_raw_capture(self):
        observation = {
            "source_ref": "source:browser-surface",
            "native_ref": "surface:one/capture:one",
            "cursor": {"kind": "capture-identity", "value": "capture:one"},
            "observed_at": "2026-09-01T00:00:00.000Z",
            "payload": capture_payload(),
        }
        result = self.validate({
            "batch_ref": "batch:capture:one",
            "source_ref": "source:browser-surface",
            "observations": [observation],
        })
        self.assertEqual(result["accepted"], [])
        self.assertIn("rejection", result)


if __name__ == "__main__":
    unittest.main()
