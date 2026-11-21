"""Appends the questions from one of a researcher's packages to questions.json, without touching existing entries.

usage: add_package_questions.py <questions.json> <package file> <package name> <settings.json>
How each package is read (where its questions are, its columns, how its bucket codes or names map to this library's
buckets) is the person's settings (their settings row, or the settings, read through tools/settings): `packages`, one
entry per package name; `note` is the library's note written back.
A package question its entry's `observed` rule matches joins as evidence=observed, with the asker's exact words as the
question and its source url. Every other package question is an authored research hypothesis and joins as
evidence=hypothesis: it is never a viewer's sentence and never measured demand. A package bucket with no bucket here
is kept as `proposed_bucket` (bucket null) until the person says it joins their buckets.
A question already in questions.json (same text, case and spacing ignored) is skipped, and so is a package question
already merged (same source_url_or_file), so a second run adds nothing. New ids continue after the highest vq- id.
Answer moments are not matched here (build_library.py's reranker owns that); answer_moments is [] and
asker_line_gate is null until apply_gate.py runs. The last line printed is {"result": {added, skipped, total}}.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "settings", "read-data"))
import settings as person_settings  # noqa: E402

FOLDER = "collect-and-rank-viewer-questions"
TOOL = "tool:collect-and-rank-viewer-questions"


def settings_from(path):
    """The person's settings for this tool, read through tools/settings: a JSON file holding their list:settings row as
    the door read it ({id, type: "record:setting", value}, id record:setting:collect-and-rank-viewer-questions~<scope_kind>~
    <scope_id>), or a JSON file of the settings themselves."""
    given = json.load(open(path))
    if not isinstance(given, dict) or not ("value" in given or "records" in given or "settings" in given):
        return given if isinstance(given, dict) else {}
    try:
        if "id" in given and person_settings.parse_id(given["id"])[0] != FOLDER:
            raise person_settings.SettingError(f"{given['id']} holds the settings of another tool: give this tool's own row (record:setting:{FOLDER}~<scope_kind>~<scope_id>).")
        return person_settings.setting(given, FOLDER, default={}, tool=TOOL) or {}
    except person_settings.SettingError as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(2)


def norm(text):
    return re.sub(r"\s+", " ", text).strip().lower()


def codes_of(row, rule):
    value = row.get(rule["field"]) or ""
    return [c.strip() for c in value.split(rule["sep"]) if c.strip()] if rule["sep"] else ([value.strip()] if value.strip() else [])


def main():
    library_path, package_path, package_name, spec_path = sys.argv[1:5]
    spec = (settings_from(spec_path).get("packages") or {}).get(package_name)
    if spec is None:
        print(json.dumps({"error": f"The settings hold no package named {package_name!r}: add how it is read under packages."}))
        sys.exit(2)
    document = json.load(open(library_path))
    entries = document["questions"]
    seen = {norm(e["question"]) for e in entries}
    merged = {e["source_url_or_file"] for e in entries}
    next_number = max(int(e["id"][3:]) for e in entries) + 1
    added = {"observed": 0, "hypothesis": 0}
    skipped = []
    package = json.load(open(package_path))
    rows = package[spec["rows_at"]] if spec["rows_at"] else package
    for q in rows:
        rule = spec["observed"]
        observed = bool(rule) and q.get(rule["field"]) == rule["equals"]
        question = q[rule["words"]] if observed else q[spec["question"]]
        source = q[rule["url"]] if observed else f"{package_name}:{spec['file_label']}#{q[spec['id']]}"
        if source in merged or norm(question) in seen:
            skipped.append(q[spec["id"]])
            continue
        codes = codes_of(q, spec["bucket_codes"])
        bucket = next((spec["bucket_map"][c] for c in codes if c in spec["bucket_map"]), None)
        proposed = None if bucket else next((spec["proposed_buckets"][c] for c in codes if c in spec["proposed_buckets"]), None)
        icp = spec["icp_segment"]
        evidence = "observed" if observed else "hypothesis"
        entry = {
            "question": question,
            "source_url_or_file": source,
            "source_kind": "package-observed" if observed else "package-hypothesis",
            "evidence": evidence,
            "bucket": bucket,
            "kind": "question",
            "icp_segment": icp["value"] if "value" in icp else f"{icp['prefix']}{q[icp['field']]}",
            "asker_line": question,
            "frequency_estimate": None,
            "answer_moments": [],
            "id": f"vq-{next_number:03d}",
            "asker_line_gate": None,
            "package_id": q[spec["id"]],
            "package_aa_buckets": codes,
        }
        if proposed:
            entry["proposed_bucket"] = proposed
        if spec.get("status"):
            entry["status"] = spec["status"]
        entry.update({field: q.get(column) for field, column in spec["carry"].items()})
        entries.append(entry)
        seen.add(norm(question))
        merged.add(source)
        next_number += 1
        added[evidence] += 1
    document["note"] = settings_from(spec_path).get("note", document.get("note"))
    json.dump(document, open(library_path, "w"), indent=1, ensure_ascii=False)
    print("added", added, "skipped", skipped, "total", len(entries), file=sys.stderr)
    print(json.dumps({"result": {"added": added, "skipped": skipped, "total": len(entries)}}))


main()
