"""Score the held-out test lines and the never-trained (narrator) lines with a decider model, with or without a LoRA
adapter, and report how well each law's question separates bad lines from good ones.

usage: python3 -I score_held_out_lines.py <request.json | ->     writes <out_dir>/<name>.json

Request: {name, items_file, out_dir, pass_set, held_out} and either {base_model, frame, adapter?, batch?, device?, nice?,
threads?} to run the model, or {scores_from: an earlier <name>.json} to report again from the scores it kept, with no
model; or settings_record with the person's `score` settings under it.

Per law: AUC of P(fail) on bad vs good test lines, and recall on bad lines at the thresholds that fail 1%, 2% and 5%
of good lines. A line is scored per sentence and takes its highest P(fail), as the gate does. Narrator lines are each
scored whole, for every law, with the 2% threshold's verdict. `written_good` repeats AUC and recall with only the
pass set's written good lines as good lines (same register as the bad lines, so a model cannot win by telling
written from spoken). `other_law_bad_flagged_at_2pct` is the share of lines that are bad for a law outside this law's
pool and still fail this law: a high share means the model learned "slop" in general, not this law. `film` scores the
held_out lines, real copy never trained on, at those same thresholds: the share of its good lines that
would fail, by kind of copy, and how many of its bad lines are caught."""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "read-data"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from common import Refused, need, rows_of, run, with_settings  # noqa: E402
from build_training_rows import sentences  # noqa: E402

FOLDER = "fine-tune-a-small-model-on-a-persons-rules"


def auc(pos, neg):
    return sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))


def at_fpr(pos, neg, rate):
    """Lowest threshold that fails at most `rate` of good lines (ties fail together), and the recall there."""
    for t in sorted(set(neg)) + [1.0 + 1e-9]:
        t_ = t + 1e-9
        if sum(n >= t_ for n in neg) <= rate * len(neg):
            return round(t_, 5), round(sum(p >= t_ for p in pos) / len(pos), 3), round(sum(n >= t_ for n in neg) / len(neg), 4)


def asks_for(laws, test, d, film):
    asks, ref = [], []
    for lid, law in laws.items():
        for i, it in enumerate(test):
            for s in sentences(it["text"]):
                asks.append((s, law["question"], law["options"]))
                ref.append((lid, i))
        for t in d["narrator"]:
            asks.append((t, law["question"], law["options"]))
            ref.append((lid, t))
        for j, f in enumerate(film):
            for s in sentences(f["text"]):
                asks.append((s, law["question"], law["options"]))
                ref.append((lid, ("film", j)))
    return asks, ref


def report(laws, test, d, film, pf, pass_set):
    """{law: report} from pf {(law, i) | (law, narrator line) | (law, ("film", j)): P(fail)}; pure, no model."""
    out = {}
    for lid, law in laws.items():
        pos = [pf[(lid, i)] for i, it in enumerate(test) if lid in it["bad_laws"]]
        neg = [pf[(lid, i)] for i, it in enumerate(test) if it["good"]]
        r = {"question": law["question"], "fail": law["fail"], "n_bad": len(pos), "n_good": len(neg)}
        if pos and neg:
            r["auc"] = round(auc(pos, neg), 3)
            for rate in (0.01, 0.02, 0.05):
                t, rec, fp = at_fpr(pos, neg, rate)
                r[f"at_{int(rate * 100)}pct"] = {"threshold": t, "recall": rec, "good_failed": fp}
        written = [pf[(lid, i)] for i, it in enumerate(test) if it["good"] and pass_set in it["sets"]]
        if pos and written:                              # same register: good lines are the pass set's written good lines only
            r["written_good"] = {"n_good": len(written), "auc": round(auc(pos, written), 3),
                                 **{f"at_{int(x * 100)}pct": dict(zip(("threshold", "recall", "good_failed"), at_fpr(pos, written, x))) for x in (0.01, 0.02, 0.05)}}
        t2 = r["at_2pct"]["threshold"] if "at_2pct" in r else None
        if t2 is not None:                               # lines bad for laws outside this law's pool: an indicator, not a label
            other = [pf[(lid, i)] for i, it in enumerate(test) if it["bad_laws"] == [] and it["bad_for"] and not it["good"]]
            r["other_law_bad_flagged_at_2pct"] = {"n": len(other), "rate": round(sum(p >= t2 for p in other) / max(1, len(other)), 3)}
        if t2 is not None:                               # real copy, never trained on, thresholds from the test lines above
            fg = [(f, pf[(lid, ("film", j))]) for j, f in enumerate(film) if not f["breaks"] and not f["unsure"]]
            fb = [pf[(lid, ("film", j))] for j, f in enumerate(film) if lid in f["breaks"]]
            kinds = sorted({f["kind"] for f, _ in fg})
            r["film"] = {"n_good": len(fg), "n_bad": len(fb),
                         **{f"good_failed_at_{x}pct": round(sum(p >= r[f"at_{x}pct"]["threshold"] for _, p in fg) / len(fg), 3) for x in (1, 2, 5)},
                         "good_failed_at_2pct_by_kind": {k: f"{sum(p >= t2 for f, p in fg if f['kind'] == k)}/{sum(f['kind'] == k for f, _ in fg)}" for k in kinds},
                         "bad_caught_at_2pct": f"{sum(p >= t2 for p in fb)}/{len(fb)}",
                         "top_good": sorted(((round(p, 3), f["text"]) for f, p in fg), reverse=True)[:6]} if fg else {"n_good": 0, "n_bad": len(fb)}
        r["narrator"] = {t: {"p_fail": round(pf[(lid, t)], 4), "fails_at_2pct": None if t2 is None else pf[(lid, t)] >= t2} for t in d["narrator"]}
        r["top_good"] = sorted(((round(pf[(lid, i)], 3), it["text"]) for i, it in enumerate(test) if it["good"]), reverse=True)[:6]
        r["missed_bad"] = sorted((round(pf[(lid, i)], 3), it["text"]) for i, it in enumerate(test) if lid in it["bad_laws"])[:6]
        out[lid] = r
    return out


def main(req):
    req = with_settings(req, "score", FOLDER)
    name = need(req, "name", str, "the run's name; the results are written to <out_dir>/<name>.json")
    items_file = Path(need(req, "items_file", str, "items.json from build_training_rows.py")).expanduser()
    out_dir = Path(need(req, "out_dir", str, "the folder the results file is written to")).expanduser()
    pass_set = need(req, "pass_set", str, "the set name of written lines ruled good")
    if not items_file.is_file():
        raise Refused(f"items_file {items_file} is not a file: make it with build_training_rows.py")
    d = json.load(open(items_file))
    laws, test = d["laws"], [it for it in d["items"] if it["split"] == "test"]
    film = rows_of(req.get("held_out", []), "held_out")
    adapter = req.get("adapter")
    asks, ref = asks_for(laws, test, d, film)
    if "scores_from" in req:
        kept = json.load(open(Path(req["scores_from"]).expanduser()))
        pf = {}
        for lid in laws:
            s = kept["scores"][lid]
            if len(s["test"]) != len(test) or len(s["film"]) != len(film):
                raise Refused(f"scores_from was scored on other lines than items_file and held_out (law {lid}): score them again with the model")
            pf.update({(lid, i): v for i, v in enumerate(s["test"])})
            pf.update({(lid, t): v for t, v in s["narrator"].items()})
            pf.update({(lid, ("film", j)): v for j, v in enumerate(s["film"])})
        secs, adapter = 0.0, kept.get("adapter")
    else:
        common.configure(need(req, "base_model", str, "the decider model folder, or give scores_from"),
                         need(req, "frame", str, "the context the line is put in, holding {text}"), req.get("device"))
        common.quiet(req.get("nice", 15), req.get("threads", 2))
        m = common.load(adapter).eval()
        t0 = time.time()
        probs = common.score(m, asks, batch=req.get("batch", 16))
        secs = time.time() - t0
        pf = {}
        for (lid, key), p, a in zip(ref, probs, asks):
            v = p[a[2].index(laws[lid]["fail"])]
            pf[(lid, key)] = max(pf.get((lid, key), 0.0), v)
    res = {"name": name, "adapter": adapter, "date": time.strftime("%Y-%m-%d"), "asks": len(asks), "seconds": round(secs, 1),
           "laws": report(laws, test, d, film, pf, pass_set)}
    res["scores"] = {lid: {"test": [round(pf[(lid, i)], 5) for i in range(len(test))], "narrator": {t: round(pf[(lid, t)], 5) for t in d["narrator"]},
                         "film": [round(pf[(lid, ("film", j))], 5) for j in range(len(film))]} for lid in laws}
    out_dir.mkdir(exist_ok=True, parents=True)
    json.dump(res, open(out_dir / f"{name}.json", "w"), indent=1, ensure_ascii=False)
    print(f"{name}: {len(asks)} asks in {secs:.0f} s")
    for lid, r in res["laws"].items():
        if "auc" in r:
            w = r.get("written_good", {"auc": float("nan"), "at_2pct": {"recall": float("nan")}})
            print(f"  {lid:24} n_bad {r['n_bad']:3} AUC {r['auc']:.3f} recall@1% {r['at_1pct']['recall']:.3f} @2% {r['at_2pct']['recall']:.3f} @5% {r['at_5pct']['recall']:.3f}"
                  f" | written-good AUC {w['auc']:.3f} @2% {w['at_2pct']['recall']:.3f} | other-law bad flagged {r['other_law_bad_flagged_at_2pct']['rate']:.2f}")
        else:
            print(f"  {lid:24} n_bad   0")
    return {"results_file": str(out_dir / f"{name}.json"), "asks": len(asks), "seconds": res["seconds"],
            "laws": {lid: {k: r[k] for k in ("n_bad", "n_good", "auc") if k in r} | ({"recall_at_2pct": r["at_2pct"]["recall"]} if "at_2pct" in r else {}) for lid, r in res["laws"].items()}}


if __name__ == "__main__":
    sys.exit(run(main, sys.argv[1:]))
