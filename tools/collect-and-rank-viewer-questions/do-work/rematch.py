"""Re-matches every question's answer_moments against the person's own moments plus an archive's tagged moments.

usage: rematch.py <viewer-questions-dir> <moments-tagged.jsonl> <settings.json>
Pool = raw/moments/moments.jsonl (embed_moments.py writes it, with moments.npy) + moments-tagged.jsonl (as
tools/file-spoken-moments-into-topic-buckets tags them: text, start or est_start, end or est_end, timing, source,
name or source_file, path, identity). Per question: top POOL by bge-small similarity, then the bge-reranker-v2-m3
cross-encoder; the buckets in the tagged file are not used. Kept when reranker probability >= keep (0.5; all kept are
"strong"). Each match carries `reach`, how soon its recording can be cut, by the person's settings:
  recordings_reach  {"word": reach of an own moment with word times, "other": reach of any other own moment}
  reach_rules       [{"when": {"source": ..., "timing": ...}, "reach": ...}]: an archive row's reach is that of the first
                    rule whose fields all equal the row's (a rule with no fields matches every row)
  recordings_origin, archive_origin   the origin of an own moment, and the prefix of an archive row's (then its source)
Archive rows with no timing at all keep from/to null. The last line printed is {"result": {questions, with_answers, ...}}.
"""
import json
import os
import sys

import numpy as np
import torch
from sentence_transformers import CrossEncoder, SentenceTransformer

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

POOL = 40
KEEP = 0.5
PER_QUESTION = 3
PREFIX = "Represent this sentence for searching relevant passages: "


def reach(source, timing, rules):
    for rule in rules:
        if all({"source": source, "timing": timing}.get(field) == value for field, value in rule["when"].items()):
            return rule["reach"]
    return "unknown"


def main():
    root, tagged, settings_path = sys.argv[1:4]
    settings = settings_from(settings_path)
    own = dict({"word": "cuttable-now", "other": "unknown"}, **(settings.get("recordings_reach") or {}))
    rules = settings.get("reach_rules") or []
    keep = settings.get("keep", KEEP)
    pool = []
    for line in open(root + "/raw/moments/moments.jsonl"):
        row = json.loads(line)
        ssd = row["time_basis"] == "word"  # an own recording with word times
        pool.append({"clip": row["clip"], "from": row["from"], "to": row["to"], "quote": row["quote"],
                     "time_basis": row["time_basis"], "media_location": row["media_location"],
                     "reach": own["word"] if ssd else own["other"], "origin": settings.get("recordings_origin", "recordings")})
    old_count = len(pool)
    archive = []
    for line in open(tagged):
        row = json.loads(line)
        if len(row["text"].split()) < 6:
            continue
        start = row.get("start", row.get("est_start"))
        end = row.get("end", row.get("est_end"))
        if row["timing"] == "none":
            start = end = None
        name = row.get("name") or row["source_file"].split("/")[-1]
        path = row.get("path") or row["source_file"]
        archive.append({"clip": name, "from": start, "to": end, "quote": " ".join(row["text"].split()[:60]),
                          "time_basis": row["timing"], "media_location": path, "identity": row["identity"],
                          "reach": reach(row["source"], row["timing"], rules), "origin": settings.get("archive_origin", "archive-") + row["source"]})
    pool.extend(archive)
    print(old_count, "old +", len(archive), "archive", file=sys.stderr)

    model = SentenceTransformer("BAAI/bge-small-en-v1.5")
    old_vectors = np.load(root + "/raw/moments/moments.npy")
    new_vectors = model.encode([m["quote"] for m in archive], batch_size=128, normalize_embeddings=True, show_progress_bar=False)
    vectors = np.vstack([old_vectors, new_vectors])
    document = json.load(open(root + "/questions.json"))
    queries = model.encode([PREFIX + e["asker_line"] for e in document["questions"]], normalize_embeddings=True, show_progress_bar=False)
    scores = (torch.from_numpy(np.ascontiguousarray(queries, dtype=np.float32)) @ torch.from_numpy(np.ascontiguousarray(vectors, dtype=np.float32)).T).numpy()
    reranker = CrossEncoder("BAAI/bge-reranker-v2-m3")
    for position, entry in enumerate(document["questions"]):
        order = [int(i) for i in np.argsort(-scores[position])[:POOL]]
        relevance = reranker.predict([(entry["asker_line"], pool[i]["quote"]) for i in order], activation_fn=torch.nn.Sigmoid())
        picked = []
        for index, probability in sorted(zip(order, relevance), key=lambda pair: -pair[1]):
            if probability < keep or len(picked) == PER_QUESTION:
                break
            moment = pool[index]
            if any(m["clip"] == moment["clip"] and m["from"] is not None and moment["from"] is not None
                   and abs(m["from"] - moment["from"]) < 15 for m in picked):
                continue
            picked.append({**moment, "match": round(float(probability), 3), "embedding_similarity": round(float(scores[position][index]), 3),
                           "match_quality": "strong"})
        entry["answer_moments"] = picked
    json.dump(document, open(root + "/questions.json", "w"), indent=1, ensure_ascii=False)
    counts = {}
    for entry in document["questions"]:
        if entry["answer_moments"]:
            best = entry["answer_moments"][0]["reach"]
            cuttable = any(m["reach"] in settings.get("cuttable", [own["word"]]) for m in entry["answer_moments"])
            counts["cuttable-now" if cuttable else "needs-timing-or-drive:" + best] = counts.get("cuttable-now" if cuttable else "needs-timing-or-drive:" + best, 0) + 1
    print(len(document["questions"]), "questions;", sum(1 for e in document["questions"] if e["answer_moments"]), "with a strong answer;", counts, file=sys.stderr)
    print(json.dumps({"result": {"questions": len(document["questions"]), "with_answers": sum(1 for e in document["questions"] if e["answer_moments"]),
                                 "answers_by_reach": counts, "pool": len(pool)}}))


main()
