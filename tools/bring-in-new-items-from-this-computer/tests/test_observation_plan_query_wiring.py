import json
import runpy
from unittest.mock import patch
from pathlib import Path


PACKAGE_ROOT = Path(__file__).parents[1]


def test_descriptor_wrappers_preserve_string_and_decoded_object_equally():
    owner = runpy.run_path(str(PACKAGE_ROOT / "do-work/process-scripts/observe-content-sources.py"))
    descriptor = {field: f"synthetic:{field}" for field in owner["DESCRIPTOR_REQUIRED"]}
    cursor = {"kind": "synthetic", "value": "revision-one"}
    results = []
    for value in (descriptor, json.dumps(descriptor)):
        rows = [{"subject_id": descriptor["source_ref"], "value_json": value}]
        cursors = [{"subject_id": descriptor["source_ref"], "value_json": cursor}]
        namespace = owner["mode_plan"].__globals__
        with patch.dict(namespace, {"read_json": lambda path: rows if path == "descriptors" else cursors,
                                    "write_json": lambda path, result: results.append(result)}):
            owner["mode_plan"]("descriptors", "cursors", "unused")
    assert results[0] == results[1]
    assert results[0] == {"plan": [{"source_ref": descriptor["source_ref"],
                                    "descriptor": descriptor, "cursor": cursor}], "blocked": []}


def test_invalid_wrapped_values_cannot_become_source_plans():
    owner = runpy.run_path(str(PACKAGE_ROOT / "do-work/process-scripts/observe-content-sources.py"))
    for value in (None, [], "null", "[]", "{broken"):
        results = []
        namespace = owner["mode_plan"].__globals__
        with patch.dict(namespace, {"read_json": lambda path: [{"value_json": value}] if path == "descriptors" else {},
                                    "write_json": lambda path, result: results.append(result)}):
            owner["mode_plan"]("descriptors", "cursors", "unused")
        assert results[0]["plan"] == []


def test_observation_planner_reads_property_facts_by_path():
    package = json.loads((PACKAGE_ROOT / "things-to-store-and-run.json").read_text(encoding="utf-8"))
    action = next(
        thing["payload"]
        for thing in package["things"]
        if thing.get("payload", {}).get("id") == "action:observe-content-sources"
    )
    steps = {step["id"]: step for step in action["steps"]}
    for step_id, path_label in (
        ("descriptors", "prop:observed_content:source_descriptor"),
        ("cursors", "prop:observed_content:cursor"),
    ):
        query = steps[step_id]["config"]["input"]
        assert query["in"] == "path"
        assert query["path_labels"] == [path_label]
        assert query["select"] == ["subject_id", "property_id", "value_json"]
