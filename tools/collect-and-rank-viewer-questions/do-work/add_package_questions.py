A question already in questions.json (same text, case and spacing ignored) is skipped, and so is a package question
already merged (same source_url_or_file), so a second run adds nothing. New ids continue after the highest vq- id.
Answer moments are not matched here (build_library.py's reranker owns that); answer_moments is [] and
asker_line_gate is null until apply_gate.py runs.
"""
import json
import re
import sys


def norm(text):
    return re.sub(r"\s+", " ", text).strip().lower()


def codes_of(row, rule):
    value = row.get(rule["field"]) or ""
    return [c.strip() for c in value.split(rule["sep"]) if c.strip()] if rule["sep"] else ([value.strip()] if value.strip() else [])


def main():
    library_path, package_path, package_name, spec_path = sys.argv[1:5]
    spec = json.load(open(spec_path))["packages"][package_name]
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
    document["note"] = ("Real viewer questions, each with his moments that answer it, for any format that answers a viewer's question "
                        "(reverse-stitch is one). evidence=observed: the asker's own sentence at "
