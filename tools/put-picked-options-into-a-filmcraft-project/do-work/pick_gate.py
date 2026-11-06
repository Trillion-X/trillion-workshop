#!/usr/bin/env python3
# tools/put-picked-options-into-a-filmcraft-project/do-work/pick_gate.py
"""The one road for putting picked content into a protected FilmCraft project.

Purpose
    the person picks; agents build options. A film's settings row names the protected projects, the
    stances that count as a pick and the option folders agents may edit freely. This tool is the only way an agent
    changes a protected project: `apply` refuses unless the person's stand on the option is a pick, then runs the
    option's FilmCraft ops headless on the project and logs what it did.

Commands
    check <option-id>        exit 0 only if the latest decision for the option is picked
    rows                     print the latest decision of every option as JSON (the one reader of the decisions; the copy gate's pick labels use it)
    apply <option-id> --project P --ops FILE [--print]
                             check, then `filmcraft-cli --project P --save run FILE`; --print shows the
                             exact command and runs nothing. Never uses the live app's control port.

Where the settings and the decisions live
    The settings are the film's row of the person's list:settings, record:setting:put-picked-options-into-a-filmcraft-
    project~film~<film folder name> (or the id --settings-record names), read through the person's records door
    (`trillion op @own-records`, TRILLION_BIN names another) and laid over DEFAULTS by tools/settings request_settings.
    A pick is the person's stance record on the option (tools/where-a-person-stands): one record per option, its id and
    the option's identity made by that folder's own code through do-work/stance-id-from-stdin.mjs. Every read goes
    through option_decisions(); nothing here writes a decision: tool:keep-where-you-stand keeps a stand, after
    checking the person's words in their source.

Non-negotiable invariants
    1. Only a stand of the person's own (by: person) that is one of picked_stances counts. A candidate's
       "recommended" flag, a review note and a brief never count.
    2. The latest stand for an option wins, so a later disagree, or a stand taken back, withdraws a pick.
    3. The live app's control port is never contacted from here.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "settings" / "read-data"))
import settings as settings_reader  # noqa: E402  tools/settings, the one reader

FOLDER = "put-picked-options-into-a-filmcraft-project"
TOOL = "tool:put-a-picked-option-into-a-filmcraft-project"
DEFAULTS = {"picked_stances": ["agree"], "option_kind": "film-option", "option_fold": {"collapse_space": True},
            "filmcraft_cli": "filmcraft-cli", "apply_log": "pick-gate-applied.jsonl"}
NEEDED = ("protected_projects", "allowed_option_folders", "picked_stances", "option_kind", "option_fold", "filmcraft_cli", "apply_log")
TRILLION = os.environ.get("TRILLION_BIN", "trillion")
STANCE_IDS = HERE / "stance-id-from-stdin.mjs"


def door(method: str, body: dict) -> dict:
    """One operation of the person's own records door, answered as JSON."""
    try:
        done = subprocess.run([TRILLION, "op", "@own-records", method, json.dumps(body)], capture_output=True, text=True)
    except OSError as problem:
        done = subprocess.CompletedProcess([], 127, "", str(problem))
    if done.returncode:
        sys.exit(f"pick-gate: could not read the person's records through `{TRILLION}`: {(done.stderr or done.stdout).strip()[:300]}. "
                 "Pick-gate reads the stands itself, so a file you hand it cannot stand in for them.")
    return json.loads(done.stdout)


def load_config(film: Path, record_id: str | None = None) -> dict:
    record_id = record_id or settings_reader.setting_id(FOLDER, "film", film.name)
    record = door("records:read", {"id": record_id, "type": settings_reader.RECORD_TYPE})
    if record.get("value") is None:
        sys.exit(f"pick-gate: no {record_id} in the person's list:settings; write the film's settings row first")
    try:
        cfg = settings_reader.request_settings({"settings_record": {**record, "id": record_id}}, DEFAULTS, folder=FOLDER, tool=TOOL)
    except settings_reader.SettingError as problem:
        sys.exit(f"pick-gate: {problem}")
    missing = [key for key in NEEDED if key not in cfg]
    if missing:
        sys.exit(f"pick-gate: the film's settings lack {', '.join(missing)}; put them in its list:settings row")
    return cfg


def stance_ids(cfg: dict, option_ids: list[str]) -> dict[str, dict]:
    """{option_id: {id, artifact}}: the stance record id and identity of each option, made by tools/where-a-person-stands."""
    done = subprocess.run(["node", str(STANCE_IDS)], input=json.dumps({"kind": cfg["option_kind"], "fold": cfg["option_fold"], "texts": option_ids}),
                          capture_output=True, text=True)
    answer = json.loads(done.stdout.strip().splitlines()[-1]) if done.stdout.strip() else {"error": done.stderr.strip()}
    if "error" in answer:
        sys.exit(f"pick-gate: could not name the options' stance records: {answer['error']}")
    return answer["ids"]


def decision_of(option_id: str, record: dict | None, ref: dict) -> dict:
    """The decision a stance record gives: the person's own stand on this option's identity, else no stand."""
    value = (record or {}).get("value") or {}
    mine = value if value.get("by") == "person" and value.get("artifact") == ref["artifact"] else {}
    return {"decision_id": ref["id"], "option_id": option_id, "verdict": mine.get("stance"), "reason_verbatim": mine.get("why"),
            "source": "stance", "at": mine.get("at")}


def option_decisions(film: Path, cfg: dict) -> dict[str, dict]:
    """The latest decision of every option: {option_id: {decision_id, option_id, verdict, reason_verbatim, source, at}}. The one reader."""
    records, after = [], None
    while True:
        page = door("records:list", {"type": "stance", "prefix": f"stance:{cfg['option_kind']}:", "limit": 200, **({"after": after} if after else {})})
        records += page["records"]
        after = page.get("next")
        if after is None:
            break
    texts = [r["value"]["text"] for r in records if isinstance((r.get("value") or {}).get("text"), str) and r["value"].get("kind") == cfg["option_kind"]]
    refs = stance_ids(cfg, texts) if texts else {}
    latest = {}
    for record in records:
        text = (record.get("value") or {}).get("text")
        if text in refs and record.get("id") == refs[text]["id"]:
            latest[text] = decision_of(text, record, refs[text])
    return latest


def latest_verdict(film: Path, cfg: dict, option_id: str) -> dict | None:
    ref = stance_ids(cfg, [option_id])[option_id]
    record = door("records:read", {"id": ref["id"], "type": "stance"})
    row = decision_of(option_id, record, ref)
    return row if row["verdict"] is not None else None


def require_pick(film: Path, cfg: dict, option_id: str) -> dict:
    row = latest_verdict(film, cfg, option_id)
    if row is None or row.get("verdict") not in cfg["picked_stances"]:
        state = f"latest stand '{row.get('verdict')}'" if row else "no stand kept"
        sys.exit(f"pick-gate: REFUSED. Option '{option_id}' has {state}; "
                 f"only the person's own pick lets it into a protected project. A 'recommended' flag is not a pick.")
    return row


def is_protected(film: Path, cfg: dict, project: Path) -> bool:
    rel = os.path.relpath(project.resolve(), film)
    if any(rel.startswith(folder.rstrip("/") + "/") for folder in cfg["allowed_option_folders"]):
        return False
    from fnmatch import fnmatch
    return any(fnmatch(rel, pattern) for pattern in cfg["protected_projects"])


def cmd_check(args, film, cfg) -> int:
    row = require_pick(film, cfg, args.option_id)
    print(f"picked: {row['option_id']} ({row['verdict']}) decision {row.get('decision_id')}")
    return 0


def cmd_rows(args, film, cfg) -> int:
    print(json.dumps(list(option_decisions(film, cfg).values()), ensure_ascii=False))
    return 0


def cmd_apply(args, film, cfg) -> int:
    import blake3
    row = require_pick(film, cfg, args.option_id)
    project, ops = Path(args.project).expanduser().resolve(), Path(args.ops).expanduser().resolve()
    if not project.is_file() or not ops.is_file():
        sys.exit("pick-gate: --project and --ops must be existing files")
    if not str(ops).startswith(str(film) + "/"):
        sys.exit(f"pick-gate: ops file must live inside {film}")
    command = [cfg["filmcraft_cli"], "--project", str(project), "--save", "run", str(ops)]
    if args.print:
        print(" ".join(command))
        return 0
    result = subprocess.run(command, capture_output=True, text=True)
    entry = {
        "at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "option_id": args.option_id, "verdict_decision_id": row.get("decision_id"),
        "verdict": row["verdict"], "project": str(project), "protected": is_protected(film, cfg, project),
        "ops_file": str(ops), "ops_hash": "blake3:" + blake3.blake3(ops.read_bytes()).hexdigest(),
        "exit": result.returncode, "stdout_tail": result.stdout[-400:], "stderr_tail": result.stderr[-400:],
    }
    with open(film / cfg["apply_log"], "a") as log:
        log.write(json.dumps(entry) + "\n")
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--film", default=os.environ.get("PICK_GATE_FILM"), help="the film's folder; its name picks the settings row")
    parser.add_argument("--settings-record", help="the id of the film's list:settings row, when it is not the one the folder name gives")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check").add_argument("option_id")
    sub.add_parser("rows")
    apply = sub.add_parser("apply")
    apply.add_argument("option_id")
    apply.add_argument("--project", required=True)
    apply.add_argument("--ops", required=True)
    apply.add_argument("--print", action="store_true")
    args = parser.parse_args()
    if not args.film:
        sys.exit("pick-gate: pass --film <the film's folder> or set PICK_GATE_FILM")
    film = Path(args.film).expanduser().resolve()
    cfg = load_config(film, args.settings_record)
    return {"check": cmd_check, "rows": cmd_rows, "apply": cmd_apply}[args.cmd](args, film, cfg)


if __name__ == "__main__":
    sys.exit(main())
