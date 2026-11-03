"""The registry the tests use: the shipped registry plus made-up dimensions that a table of units can measure.

The shipped registry holds no craft-specific dimensions. A person who measures a craft passes their own registry with
`--registry`; these tests do the same with a registry whose dimensions are invented for the tests (a table of tasting
samples), so the table reader, the category, text and number comparators and the pending rules are exercised without
any one person's vocabulary in the repository. A few sound and rhythm dimensions let the earshot, motion-rhythm and
temporal-scan readers be measured the same way. Importing this module points the default registry at that file.
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
    # Sound and rhythm measurements, read from made-up earshot, motion-rhythm and temporal-scan outputs.
    {"id": "sound.sfx", "name": "sound effects", "media": ["video"], "region": "sound", "value_kind": "event",
     "measure": [{"reader": "earshot_events", "field": "kind", "token": "record", "where": {"kind": ["WHOOSH", "RISER"]}}],
     "drift": {"tolerance_s": 0.1, "match_value": False, "threshold": 1.0}},
    {"id": "music.section", "name": "music sections", "media": ["video"], "region": "sound", "value_kind": "event",
     "measure": [{"reader": "earshot_sections", "field": "genre", "token": "record"}], "drift": {"tolerance_s": 0.5, "match_value": False, "threshold": 1.0}},
    {"id": "loudness.lufs", "name": "integrated loudness", "media": ["video"], "region": "sound", "value_kind": "number", "unit": "LUFS",
     "measure": [{"reader": "earshot_sections", "field": "lufs", "token": "record"}], "drift": {"threshold": 1.0, "max": 1.0}},
    {"id": "cut.time", "name": "cut times", "media": ["video"], "region": "cuts", "value_kind": "event",
     "measure": [{"reader": "rhythm_segments", "field": "cut", "token": "record", "where": {"cut": ["cut"]}}], "drift": {"tolerance_s": 0.07, "threshold": 1.0}},
    {"id": "cut.hold_s", "name": "hold length per segment", "media": ["video"], "region": "cuts", "value_kind": "number", "unit": "s",
     "measure": [{"reader": "rhythm_segments", "field": "hold_s", "token": "record"}], "drift": {"rel": 0.15, "threshold": 1.0, "max": 0.1}},
    {"id": "pacing.cuts_per_min", "name": "cuts per minute", "media": ["video"], "region": "cuts", "value_kind": "number", "unit": "/min",
     "measure": [{"reader": "rhythm_segments", "field": "cuts_per_min", "token": "record"}], "drift": {"rel": 0.1, "threshold": 1.0}},
    {"id": "cut.flash", "name": "flash frames", "media": ["video"], "region": "cuts", "value_kind": "event",
     "measure": [{"reader": "scan_events", "field": "kind", "token": "record", "where": {"kind": ["flash_candidate"]}}], "drift": {"tolerance_s": 0.07, "threshold": 1.0}},
]


def install():
    data = json.loads(wt_core.DEFAULT_REGISTRY.read_text(encoding="utf-8"))
    data["dimensions"].extend(SAMPLE_DIMENSIONS)
    data["media"]["video"]["regions"].extend(["samples", "sound", "cuts"])
    path = Path(tempfile.mkdtemp(prefix="template-tool-registry-")) / "dimensions.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    wt_core.DEFAULT_REGISTRY = path


install()
