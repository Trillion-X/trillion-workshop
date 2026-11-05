from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

PICK_LABELS_TOOL = Path(__file__).resolve().parents[1] / "copy-gate" / "verdicts.mjs"


def load_config(film: Path) -> dict:
    path = film / "pick-gate.json"
    if not path.is_file():
        sys.exit(f"pick-gate: no pick-gate.json in {film}")
    return json.loads(path.read_text())


def option_decisions(film: Path, cfg: dict) -> dict[str, dict]:
    """The latest decision of every option: {option_id: {decision_id, option_id, verdict, reason_verbatim, lines?, source, at}}. The one reader."""
    path = film / cfg["verdict_file"]
    latest = {}
    for line in path.read_text().splitlines() if path.is_file() else []:
        line = line.strip()
        if line:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if "option_id" in row:
                latest[row["option_id"]] = row
    return latest


def record_decision(film: Path, cfg: dict, row: dict) -> None:
    """Records one decision on an option, his reason verbatim. The one writer."""
    with open(film / cfg["verdict_file"], "a") as out:
        out.write(json.dumps(row, ensure_ascii=False) + "\n")


def latest_verdict(film: Path, cfg: dict, option_id: str) -> dict | None:
    return option_decisions(film, cfg).get(option_id)


def require_pick(film: Path, cfg: dict, option_id: str) -> dict:
    row = latest_verdict(film, cfg, option_id)
    if row is None or row.get("verdict") not in cfg["picked_verdicts"]:
        state = f"latest verdict '{row.get('verdict')}'" if row else "no verdict row"
        sys.exit(f"pick-gate: REFUSED. Option '{option_id}' has {state} in {cfg['verdict_file']}; "
