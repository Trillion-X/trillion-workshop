#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/affect/affect_au_emit.py
#
# =============================================================================
# Apeak passive-perception SOURCE — the affect-face tracker as a process-job.
# =============================================================================
# The producer half of the passive-perception lane: a real face frame (image or
# a video frame path) -> py-feat / OpenFace-family detector -> a RAW, self-
# describing `affect.au_window` fact (raw action-unit intensities + a gaze/head
# direction + face-detection confidence + model provenance). This is the EXACT
# emit-raw-derive-downstream pattern proven for court/ball (match_perception_*):
# the tracker emits raw facts with its OWN contract; downstream MEASURES
# (flow-probability, attentional-stability — progression-evaluator DATA) derive
# arousal/attention from the raw AUs/gaze. The tracker NEVER computes arousal
# itself (that convention lives in the measure DATA, not this binary — L089).
#
# Output: one JSON object per detected face -> stdout (the process-engine turns
# `command-output.json` into a canonical provided record under the descriptor's
# published path). Fail-closed: no face / low confidence -> emit nothing (never
# a fabricated fact); every fact carries `confidence` + `provenance` so the
# corroboration gate can reject uncorroborated single-channel readings (L117).
#
# Usage: affect_au_emit.py <image-or-frame> [--out command-output.json]
# =============================================================================
import sys, json, warnings, os
warnings.filterwarnings("ignore")


def _num(x):
    try:
        v = float(x)
        return v if v == v else None  # drop NaN
    except (TypeError, ValueError):
        return None


def _cols_like(columns, *needles):
    """First column whose lowercased name contains ALL needles (order-free)."""
    for c in columns:
        lc = c.lower()
        if all(n in lc for n in needles):
            return c
    return None


def detect(image_path):
    from feat import Detector
    det = Detector()
    fex = det.detect_image(image_path)
    cols = list(fex.columns)
    au_cols = [c for c in cols if c.lower().startswith("au") and _num(fex[c].iloc[0]) is not None]
    emo_names = ["anger", "disgust", "fear", "happiness", "sadness", "surprise", "neutral"]
    emo_cols = {e: c for e in emo_names for c in [_cols_like(cols, e)] if c}
    yaw = _cols_like(cols, "yaw")          # horizontal head/gaze direction (attention proxy)
    pitch, roll = _cols_like(cols, "pitch"), _cols_like(cols, "roll")
    score = _cols_like(cols, "facescore") or _cols_like(cols, "face", "score") or _cols_like(cols, "score")

    facts = []
    for i in range(len(fex)):
        conf = _num(fex[score].iloc[i]) if score else None
        aus = {c.upper(): _num(fex[c].iloc[i]) for c in au_cols if _num(fex[c].iloc[i]) is not None}
        if not aus:
            continue  # fail-closed: no usable AU signal -> no fact
        fact = {
            "id": "affect.au_window:%s:%d" % (os.path.basename(image_path), i),
            "kind": "affect.au_window",
            "source": "affect-face-pyfeat",  # modality tag the corroboration gate reads (config.corroborating_modalities)
            "aus": aus,
            "gaze": _num(fex[yaw].iloc[i]) if yaw else None,     # yaw as gaze-direction proxy
            "headpose": {k: _num(fex[c].iloc[i]) for k, c in (("pitch", pitch), ("roll", roll), ("yaw", yaw)) if c},
            "emotions": {e: _num(fex[c].iloc[i]) for e, c in emo_cols.items() if _num(fex[c].iloc[i]) is not None},
            "confidence": conf if conf is not None else 0.0,
            "window": {"frame": i, "source": os.path.basename(image_path)},
            "provenance": {"model": "py-feat", "detector": "pyfeat.Detector", "modality": "affect-face"},
        }
        facts.append(fact)
    return facts


def main(argv):
    if not argv:
        print("usage: affect_au_emit.py <image> [--out file]", file=sys.stderr)
        return 2
    image = argv[0]
    out = None
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]
    facts = detect(image)
    payload = {"fact_kind": "affect.au_window", "facts": facts, "count": len(facts)}
    text = json.dumps(payload, indent=2)
    if out:
        with open(out, "w") as f:
            f.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
