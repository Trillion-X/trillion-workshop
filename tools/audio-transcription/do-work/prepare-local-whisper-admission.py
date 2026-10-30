#!/usr/bin/env python3
from __future__ import annotations

import json
import pathlib
import re
import sys


def refuse(message: str) -> None:
    raise SystemExit(f"local Whisper admission refused: {message}")


def main() -> None:
    if len(sys.argv) != 6:
        refuse("usage: prepare-local-whisper-admission.py <runtime-contract> <docker-inspect-json> <expected-image-id> <source-role-output> <selection-output>")
    contract_path, inspect_path, expected_image_id, source_output, selection_output = (
        pathlib.Path(value) if index != 2 else value
        for index, value in enumerate(sys.argv[1:])
    )
    contract = json.loads(contract_path.read_text())
    inspected = json.loads(inspect_path.read_text())
    if isinstance(inspected, list):
        if len(inspected) != 1 or not isinstance(inspected[0], dict) or not isinstance(inspected[0].get("admission_inspection"), dict):
            refuse("image reader output must contain exactly one admission inspection")
        inspected = inspected[0]["admission_inspection"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_image_id):
        refuse("expected image ID is not an exact sha256 identity")
    if inspected.get("Id") != expected_image_id:
        refuse("inspected image ID does not equal the reviewed build result")
    digest_pattern = re.compile(contract["local_registry_promotion"]["required_result"]["repo_digest_must_match"])
    repo_digests = inspected.get("RepoDigests") or []
    matching = sorted({value for value in repo_digests if isinstance(value, str) and digest_pattern.fullmatch(value)})
    if repo_digests:
        if len(matching) != 1:
            refuse("published image must expose exactly one matching loopback RepoDigest")
        immutable_artifact = matching[0]
    else:
        root_fs = inspected.get("RootFS")
        layers = root_fs.get("Layers") if isinstance(root_fs, dict) and root_fs.get("Type") == "layers" else None
        if not isinstance(layers, list) or not 1 <= len(layers) <= 256:
            refuse("local image must expose a bounded nonempty ordered root filesystem layer list")
        if any(not isinstance(layer, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", layer) for layer in layers):
            refuse("local image layer identity is not an exact lowercase sha256 digest")
        immutable_artifact = f"local-oci-image/rootfs/{'+'.join(layers)}@{expected_image_id}"
    provider = dict(contract["provider"])
    provider["immutable_runtime_artifact"] = immutable_artifact
    alias = {
        "kind": "external_provider",
        "provider": provider,
        "network_allowed": contract["runtime"]["network_allowed"],
        "max_runtime_ms": contract["runtime"]["max_runtime_ms"],
    }
    projection = contract["local_process_role_projection"]
    source_descriptor = {
        "schema": "bitfield.app_open_process_role_descriptor",
        "process_roles": [{
            "role_id": projection["source_role_id"],
            "process_admission": {"runtime_aliases": {contract["runtime_alias"]: alias}},
        }],
    }
    source_output.parent.mkdir(parents=True, exist_ok=True)
    source_output.write_text(json.dumps(source_descriptor, indent=2) + "\n")
    selection = {
        "schema": projection["selection_schema"],
        "source_descriptor": str(source_output.resolve()),
        "source_role_id": projection["source_role_id"],
        "expected_skeleton_role_id": projection["expected_skeleton_role_id"],
        "runtime_alias_selections": [projection["runtime_alias_selection"]],
    }
    selection_output.parent.mkdir(parents=True, exist_ok=True)
    selection_output.write_text(json.dumps(selection, indent=2) + "\n")
    print(immutable_artifact)


if __name__ == "__main__":
    main()
