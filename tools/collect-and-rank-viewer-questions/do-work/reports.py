"""The views of a questions.json for reading, each printed one line a question, and a last line {"result": ...}.

usage: reports.py shortlist <questions.json>
       reports.py answers <questions.json>
       reports.py review <questions.json> [first] [last]
       reports.py top30 <questions.json> <out.json> <id> [<id> ...]
       reports.py brief <top30.json>
       reports.py comments <comments-dir>
       reports.py vectors <viewer-questions-dir>
shortlist: the questions worth a closer look: recurring, high-engagement, or with a strong answer moment.
answers: every question that has an answer moment, with the reach of each, and totals by reach.
review: questions.json compactly: id, bucket, question, label, then each answer moment.
top30: writes the questions to hand on first, chosen by hand (the ids), each with its best answer, and prints them.
brief: a top30.json as one line per question: id, bucket, asker line, evidence/source, answer.
comments: the downloaded video comment files (<id>.info.json): title, views, comment count, question count.
vectors: counts non-finite rows in raw/moments/moments.npy and shows the first quotes they belong to.
"""
import glob
import json
import sys


def shortlist(path):
    out = []
    for entry in json.load(open(path))["questions"]:
        frequency = entry["frequency_estimate"]
        strong = [m for m in entry["answer_moments"] if m["match_quality"] == "strong"]
        similar = frequency["similar_in_sample"] if frequency else 0
        engagement = frequency["engagement"] if frequency else {}
        interest = similar + len(strong) * 3 + (1 if entry["evidence"] == "inferred" else 0)
        if similar >= 2 or strong or engagement.get("comment_likes", 0) >= 100:
            print(f"{entry['id']} sim={similar} eng={engagement} strong={len(strong)} [{entry['bucket'][:10]}] {entry['asker_line'][:120]}")
            out.append({"id": entry["id"], "similar": similar, "engagement": engagement, "strong": len(strong),
                        "interest": interest, "bucket": entry["bucket"], "asker_line": entry["asker_line"]})
    return {"shortlist": out}


def answers(path):
    totals = {}
    out = []
    for entry in json.load(open(path))["questions"]:
        if not entry["answer_moments"]:
            continue
        print(f"{entry['id']} [{entry['evidence'][:3]}] {entry['asker_line'][:90]}")
        for moment in entry["answer_moments"]:
            totals[moment["reach"]] = totals.get(moment["reach"], 0) + 1
            print(f"    {moment['match']} {moment['reach']} {moment['origin']} {moment['clip'][:40]} {moment['from']}-{moment['to']} ({moment['time_basis']}): {moment['quote'][:110]}")
        out.append({"id": entry["id"], "evidence": entry["evidence"], "asker_line": entry["asker_line"], "answers": entry["answer_moments"]})
    print(totals)
    return {"questions": out, "answers_by_reach": totals}


def review(path, first=1, last=10**6):
    document = json.load(open(path))
    out = []
    for index, entry in enumerate(document["questions"], 1):
        if not first <= index <= last:
            continue
        frequency = entry["frequency_estimate"]
        label = frequency["label"] + "/" + str(frequency["similar_in_sample"]) if frequency else "inferred"
        print(f"{entry['id']} [{entry['bucket'][:14]}] {entry['asker_line']}  ({label})")
        for moment in entry["answer_moments"][:2]:
            print(f"    {moment['match']} {moment['clip']} {moment['from']}-{moment['to']} {moment['time_basis'][:3]}: {moment['quote'][:150]}")
        out.append({"id": entry["id"], "bucket": entry["bucket"], "asker_line": entry["asker_line"], "label": label,
                    "answers": entry["answer_moments"][:2]})
    return {"questions": out}


def top30(path, out_path, ids):
    document = json.load(open(path))
    by_id = {entry["id"]: entry for entry in document["questions"]}
    unknown = [question_id for question_id in ids if question_id not in by_id]
    if unknown:
        raise LookupError(f"No question has the id {', '.join(unknown)}: name ids the library holds.")
    chosen = []
    for question_id in ids:
        entry = by_id[question_id]
        best = entry["answer_moments"][0] if entry["answer_moments"] else None
        chosen.append({"id": entry["id"], "bucket": entry["bucket"], "kind": entry["kind"], "icp_segment": entry["icp_segment"],
                       "evidence": entry["evidence"], "asker_line": entry["asker_line"], "question": entry["question"],
                       "source": entry["source_url_or_file"], "frequency_estimate": entry["frequency_estimate"],
                       "best_answer": best})
    json.dump(chosen, open(out_path, "w"), indent=1, ensure_ascii=False)
    for item in chosen:
        best = item["best_answer"]
        answer = f"{best['clip']} {best['from']}-{best['to']} ({best['match_quality']} {best['match']}): {best['quote'][:90]}" if best else "no clip yet"
        print(item["id"], item["bucket"][:12], item["asker_line"][:80], "|", answer)
    return {"chosen": len(chosen), "out": out_path}


def brief(path):
    out = []
    for item in json.load(open(path)):
        best = item["best_answer"]
        answer = f"{best['clip']} {best['from']}-{best['to']} {best['match']} {best['reach']}" if best else "no clip"
        frequency = item["frequency_estimate"]
        seen = f"{frequency['label']} {frequency['engagement']}" if frequency else "inferred"
        source = item["source"].replace("https://www.reddit.com", "reddit").split("/ICP")[-1]
        print(f"{item['id']} | {item['bucket']} | \"{item['asker_line']}\" | {seen} | {source} | {answer}")
        out.append({"id": item["id"], "bucket": item["bucket"], "asker_line": item["asker_line"], "seen": seen, "source": source, "answer": answer})
    return {"brief": out}


def comments(folder):
    out = []
    for path in sorted(glob.glob(folder + "/*.json")):
        info = json.load(open(path))
        comments = info.get("comments") or []
        questions = sum(1 for c in comments if "?" in c["text"])
        print(path.split("/")[-1], (info.get("title") or "")[:70], info.get("view_count"), len(comments), questions)
        out.append({"file": path.split("/")[-1], "title": info.get("title"), "views": info.get("view_count"),
                    "comments": len(comments), "questions": questions})
    return {"videos": out}


def vectors(root):
    import numpy as np

    vectors = np.load(root + "/raw/moments/moments.npy")
    bad = np.where(~np.isfinite(vectors).all(axis=1))[0]
    print(len(vectors), "rows;", len(bad), "non-finite")
    rows = [json.loads(line) for line in open(root + "/raw/moments/moments.jsonl")]
    for index in bad[:5]:
        print(index, rows[index]["quote"][:100])
    return {"rows": len(vectors), "not_finite": len(bad), "first": [{"row": int(i), "quote": rows[i]["quote"][:100]} for i in bad[:5]]}


VIEWS = {"shortlist": shortlist, "answers": answers, "review": review, "top30": top30, "brief": brief,
         "comments": comments, "vectors": vectors}


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in VIEWS:
        print(json.dumps({"error": f"Name a view ({', '.join(VIEWS)}) and its file: see the usage at the top of reports.py."}))
        sys.exit(2)
    view, args = sys.argv[1], sys.argv[2:]
    try:
        if view == "review":
            result = review(args[0], *(int(a) for a in args[1:3]))
        elif view == "top30":
            result = top30(args[0], args[1], args[2:])
        else:
            result = VIEWS[view](args[0])
    except LookupError as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(2)
    print(json.dumps({"result": result}, ensure_ascii=False))


main()
