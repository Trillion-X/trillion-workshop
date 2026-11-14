#!/usr/bin/env python3
# tools/match/source_group.py
#
# PURPOSE: The LABEL-FREE source-video grouping primitive. Pure function: a .desc.json path → a normalized
# parent-video key, so sub-clips of the same source video are grouped and excluded from each other's candidate
# pool (same-source siblings share near-identical appearance → an embedding would score ~1.0 retrieving its own
# near-duplicates = leakage, not viewpoint understanding).
#
# WHY ITS OWN MODULE (iter61, L063 split-by-concern + L091 import-isolation): this lived in eval_viewpoint.py
# alongside label_of()/vp_label() — the GROUND-TRUTH (stroke/view label) extractors used ONLY by the recall
# scorers. The product encoders (view_encoder / motion_encoder, imported by the core matcher correspondence.py)
# need source_group for leakage exclusion, but importing it FROM eval_viewpoint dragged the label-aware module
# into the matcher's runtime import closure — violating the matcher's defining invariant: it certifies motion
# GEOMETRY and NEVER consults a label ("wrong-match structurally impossible" rests on there being no label to
# corrupt). The structural import-isolation lock (tools/test_effector_genericity.py §7) caught the reach.
# source_group is label-free, so it belongs in a label-free home; eval_viewpoint re-imports it (SSOT: defined
# ONCE here), and the product encoders import it here — so the product closure no longer reaches any scorer.
#
# Self-describing data, generic handler (L090): the discriminant (the source key) is derived from the clip's own
# self-described source path — no domain vocabulary, no enum, works for any corpus.
from __future__ import annotations
import json, re
from pathlib import Path
import finite_json as FJ  # #198.6: descriptor read travels the finite waist (a NaN in a descriptor → NonFiniteJSON, caught by the except → safe fallback)


def source_group(descfile: str) -> str:
    """Normalized SOURCE-VIDEO key so sub-clips of the same parent video are grouped. Same-source
    siblings share near-identical appearance — they MUST be excluded from each other's candidate pool
    or an appearance/identity embedding scores ~1.0 by retrieving its own near-duplicates (leakage),
    not by understanding viewpoint."""
    try: d = FJ.load_text(descfile)  # #198.6: descriptor read via finite waist
    except Exception: return descfile
    name = (d.get("source", {}).get("path", "") or descfile).split("/")[-1].lower()
    name = re.sub(r"_sub_[\d.]+", "", name)
    name = re.sub(r"\s*-\s*horizontal", "", name)
    name = re.sub(r"\s*pick ?up\s*\d*", "", name)
    name = re.sub(r"\.(mp4|mov)$", "", name)
    return name.strip()
