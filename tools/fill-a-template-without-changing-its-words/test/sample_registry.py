"""The registry the tests use: the shipped registry plus made-up dimensions that a table of units can measure.

The shipped registry holds no craft-specific dimensions. A person who measures a craft passes their own registry with
`--registry`; these tests do the same with a registry whose dimensions are invented for the tests (a table of tasting
samples), so the table reader, the category, text and number comparators and the pending rules are exercised without
any one person's vocabulary in the repository. Importing this module points the default registry at that file.
"""
import json
import tempfile
from pathlib import Path

import wt_core

SAMPLE_DIMENSIONS = [
    {"id": "sample.size", "name": "sample size", "media": ["video"], "region": "samples", "value_kind": "category",
     "measure": [{"reader": "tsv_rows", "field": "size", "token": "record"}], "drift": {"threshold": 1.0}},
    {"id": "sample.angle", "name": "pouring angle", "media": ["video"], "region": "samples", "value_kind": "category",
     "measure": [{"reader": "tsv_rows", "field": "angle", "token": "record"}], "drift": {"threshold": 1.0}},
    {"id": "sample.grade", "name": "roast grade", "media": ["video"], "region": "samples", "value_kind": "category",
     "measure": [{"reader": "tsv_rows", "field": "grade", "token": "record"}], "drift": {"threshold": 1.0}},
    {"id": "sample.width", "name": "cup width", "media": ["video"], "region": "samples", "value_kind": "category",
     "measure": [{"reader": "tsv_rows", "field": "width", "token": "record"}], "drift": {"threshold": 1.0}},
    {"id": "sample.pace", "name": "pouring pace", "media": ["video"], "region": "samples", "value_kind": "category",
     "measure": [{"reader": "tsv_rows", "field": "pace", "token": "record"}], "drift": {"threshold": 1.0}},
    {"id": "sample.action", "name": "what happens", "media": ["video"], "region": "samples", "value_kind": "text",
     "measure": [{"reader": "tsv_rows", "field": "action", "token": "record"}], "drift": {"threshold": 1.0}},
    {"id": "sample.place", "name": "where it happens", "media": ["video"], "region": "samples", "value_kind": "text",
     "measure": [{"reader": "tsv_rows", "field": "place", "token": "record"}], "drift": {"threshold": 1.0}},
]


def install():
    data = json.loads(wt_core.DEFAULT_REGISTRY.read_text(encoding="utf-8"))
    data["dimensions"].extend(SAMPLE_DIMENSIONS)
    data["media"]["video"]["regions"].append("samples")
    path = Path(tempfile.mkdtemp(prefix="template-tool-registry-")) / "dimensions.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    wt_core.DEFAULT_REGISTRY = path


install()
