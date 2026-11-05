"""Builds library/viewer-questions/questions.json from the hand-picked candidates.

usage: build_library.py <viewer-questions-dir> <picks.txt> <settings.json>
Inputs (all under <dir>/raw unless noted): candidates.tsv (candidates.py writes it), the forum posts (<dir>/forum-posts.jsonl
or raw/reddit.jsonl, for each post's comment count), moments/moments.jsonl + moments.npy (embed_moments.py writes them);
<picks.txt>: the person's picks, one a line (candidate id, bucket code, kind; # starts a note).
<settings.json> holds the person's settings row (or the settings), read through tools/settings:
  bucket_codes      {code: bucket name}: the codes the picks use
  kinds             {code: kind} (default: q question, i issue, p problem, d dream, o outcome)
  asker_overrides   {candidate id: the asker line to use}
  inferred          [[number, code, kind, question]]: questions written by someone other than a viewer, read from the
                    file named in inferred_file (each source is <inferred_file>:<number>), in inferred_segment
  comment_segment   the segment of a comment's question, {} where the video's segment goes
  basis, note, buckets_note   the words that say what the sample, the library and the buckets are
  moment_buckets    {name: {description}} or [[name, {description}]]: each answer moment's nearest bucket is written as
                    moment_bucket_field
A question is always the asker's verbatim sentence. Frequency is measured, not guessed: how many other
sentences in the whole sample (every candidate from 25 subreddits and 8 YouTube videos) mean nearly the same thing,
plus the post's score and comment count or the comment's likes.
"""
import json
import os
import re
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

SIMILAR = 0.82
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
MOMENT_MIN = 0.25
RERANK_POOL = 40
MOMENTS_PER_QUESTION = 3
KINDS = {"q": "question", "i": "issue", "p": "problem", "d": "dream", "o": "outcome"}
LEAD = re.compile(r"^(and|but|so|or|also|plus|hi everyone,?|guys,?|hey,?|ok,?|okay,?)\s+", re.I)


def asker_line(question):
    line = re.sub(r"[\\*_`>]+", "", question)
    line = re.sub(r"\s+", " ", line).strip(" -,;:\"'")
    line = LEAD.sub("", line)
    line = re.sub(r"\s+\?$", "?", line)
    line = line[0].upper() + line[1:]
    return line


def main():
    root, picks, settings_path = sys.argv[1:4]
    settings = settings_from(settings_path)
    CODES = settings.get("bucket_codes") or {}
    kinds = dict(KINDS, **(settings.get("kinds") or {}))
    icp_file = settings.get("inferred_file", "inferred")
    raw = root + "/raw"
    candidates = {}
    for line in open(raw + "/candidates.tsv"):
        index, kind, url, segment, score, question = line.rstrip("\n").split("\t")
        candidates[index] = {"kind": kind, "url": url, "segment": segment, "score": int(score), "question": question}
    comments = {}
    posts = [path for path in (root + "/forum-posts.jsonl", raw + "/reddit.jsonl") if os.path.exists(path)]
    for line in (line for path in posts for line in open(path) if line.strip()):
        post = json.loads(line)
        comments["https://www.reddit.com" + (post["permalink"] or "")] = post["num_comments"] or 0
    overrides = settings.get("asker_overrides") or {}
    bucket_info = settings.get("moment_buckets") or {}
    if isinstance(bucket_info, list):  # [[name, {description}], ...]: the order kept in a row whose keys are sorted
        bucket_info = dict(bucket_info)
    unknown = sorted({line.split()[1] for line in open(picks) if line.strip() and not line.startswith("#")} - set(CODES))
    if unknown:
        print(json.dumps({"error": f"The picks use bucket codes the settings do not name ({', '.join(unknown)}): add them to bucket_codes."}))
        sys.exit(2)

    entries = []
    for line in open(picks):
        if line.startswith("#") or not line.strip():
            continue
        index, code, kind = line.split()
        c = candidates[index]
        if c["kind"] == "youtube-comment":
            engagement = {"comment_likes": c["score"]}
            segment = settings.get("comment_segment", "{}").format(c["segment"])
        else:
            engagement = {"post_score": c["score"], "post_comments": comments.get(c["url"], 0)}
            segment = c["segment"]
        entries.append({"candidate": index, "question": c["question"], "source_url_or_file": c["url"],
                        "source_kind": c["kind"], "evidence": "observed", "bucket": CODES[code], "kind": kinds[kind],
                        "icp_segment": segment, "engagement": engagement,
                        "asker_line": overrides.get(index) or asker_line(c["question"])})
    for number, code, kind, question in settings.get("inferred") or []:
        entries.append({"candidate": None, "question": question, "source_url_or_file": f"{icp_file}:{number}",
                        "source_kind": "icp-file", "evidence": "inferred", "bucket": CODES[code], "kind": kinds[kind],
                        "icp_segment": settings.get("inferred_segment", "inferred"), "engagement": None, "asker_line": asker_line(question)})

    model = SentenceTransformer("BAAI/bge-small-en-v1.5")
    sample = [c["question"] for c in candidates.values()]
    sample_vectors = model.encode(sample, batch_size=128, normalize_embeddings=True, show_progress_bar=False)
    asker = model.encode([e["asker_line"] for e in entries], batch_size=64, normalize_embeddings=True, show_progress_bar=False)
    queries = model.encode([QUERY_PREFIX + e["asker_line"] for e in entries], batch_size=64, normalize_embeddings=True, show_progress_bar=False)
    moments = [json.loads(line) for line in open(raw + "/moments/moments.jsonl")]
    moment_vectors = np.load(raw + "/moments/moments.npy")
    descriptions = {name: b["description"] for name, b in bucket_info.items() if b.get("description")}
    description_vectors = model.encode(list(descriptions.values()), normalize_embeddings=True, show_progress_bar=False)
    description_names = list(descriptions.keys())

    similarity = asker @ sample_vectors.T
    scores = np.nan_to_num(queries @ moment_vectors.T, nan=-1.0)
    reranker = CrossEncoder("BAAI/bge-reranker-v2-m3")
    for position, entry in enumerate(entries):
        if entry["evidence"] == "observed":
            near = max(0, int((similarity[position] >= SIMILAR).sum()) - 1)
            entry["frequency_estimate"] = {
                "similar_in_sample": near, "sample_size": len(sample), "similarity_threshold": SIMILAR,
                "engagement": entry.pop("engagement"),
                "label": "recurs" if near >= 4 else "seen-elsewhere" if near >= 1 else "single-sighting",
                "basis": settings.get("basis", "sentences ending in a question mark in the candidates sample; not a count of the whole internet")}
        else:
            entry.pop("engagement")
            entry["frequency_estimate"] = None
        order = [int(i) for i in np.argsort(-scores[position])[:RERANK_POOL]]
        relevance = reranker.predict([(entry["asker_line"], moments[i]["quote"]) for i in order], activation_fn=torch.nn.Sigmoid())
        ranked = sorted(zip(order, relevance), key=lambda pair: -pair[1])
        picked, used = [], []
        for moment_index, probability in ranked:
            if probability < MOMENT_MIN or len(picked) == MOMENTS_PER_QUESTION:
                break
            moment = moments[moment_index]
            if any(m["clip"] == moment["clip"] and abs(m["from"] - moment["from"]) < 15 for m in used):
                continue
            used.append(moment)
            best = int(np.argmax(description_vectors @ moment_vectors[int(moment_index)])) if description_names else 0
            picked.append({"clip": moment["clip"], "from": moment["from"], "to": moment["to"], "quote": moment["quote"],
                           "match": round(float(probability), 3), "embedding_similarity": round(float(scores[position][moment_index]), 3),
                           "match_quality": "strong" if probability >= 0.5 and scores[position][moment_index] >= 0.72 else "possible", "time_basis": moment["time_basis"],
                           "media_location": moment["media_location"], settings.get("moment_bucket_field", "moment_bucket"): description_names[best] if description_names else None})
        entry["answer_moments"] = picked
        entry["id"] = f"vq-{position + 1:03d}"
        entry["asker_line_gate"] = None
        entry.pop("candidate")
    json.dump({"note": settings.get("note", "Real viewer questions, each with the person's moments that answer it. evidence=observed: the asker's own sentence at source_url_or_file. evidence=inferred: written by someone other than a viewer, not observed from a viewer."),
               "buckets": settings.get("buckets_note", "the person's buckets"),
               "questions": entries}, open(root + "/questions.json", "w"), indent=1, ensure_ascii=False)
    print(len(entries), "entries;", sum(1 for e in entries if e["answer_moments"]), "with answer moments", file=sys.stderr)
    print(json.dumps({"result": {"questions": len(entries), "with_answers": sum(1 for e in entries if e["answer_moments"]), "out": root + "/questions.json"}}))


main()
