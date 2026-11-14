# affect/ — Affect-face perception process-job (Apeak passive-perception SOURCE)

The producer half of the Apeak passive-perception lane: a real face frame → py-feat / OpenFace-family detection → a RAW self-describing `affect.au_window` fact, following the proven court-ball emit-raw-derive-downstream pattern (the tracker emits raw facts; downstream measures derive arousal/attention).

## Files

| File | Purpose |
|------|---------|
| `affect_au_emit.py` | Runs py-feat `Detector.detect_image` on a face image/frame and emits one raw `affect.au_window` fact per detected face (raw AU intensities + gaze/head-pose + emotions + face-detection confidence + provenance). Fail-closed: no face / no usable AU → emits nothing. |
| `README.md` | This file. |

## Key Functions

| Function | Signature / Shape | Role |
|----------|-------------------|------|
| `detect(image_path)` | `(str) -> list[fact]` | Detector + extraction; returns raw `affect.au_window` facts |
| `_cols_like(cols, *needles)` | `(list, *str) -> str\|None` | Robust column lookup (py-feat casing-agnostic: `AU06`, `Yaw`, `FaceScore`) |
| `main(argv)` | `affect_au_emit.py <image> [--out file]` | CLI entry; prints the fact batch JSON to stdout (+ optional `--out`) |

## Emitted fact contract (raw, self-describing)

```json
{ "id": "affect.au_window:<src>:<frame>", "kind": "affect.au_window",
  "aus": {"AU01": .., "AU04": .., "AU06": .., "AU07": .., "AU12": .., ...},
  "gaze": <Yaw>, "headpose": {"pitch":..,"roll":..,"yaw":..},
  "emotions": {"happiness":..,"anger":..,...}, "confidence": <FaceScore>,
  "window": {"frame":0,"source":"<src>"},
  "provenance": {"model":"py-feat","modality":"affect-face"} }
```

The DERIVED measures (progression-evaluator DATA, cont.63b) read the raw fields: `flow-probability` reads `aus.AU04/05/07/23` + `rmssd`; `attentional-stability` reads `gaze`. The tracker NEVER computes arousal/attention (L089 — that convention is measure DATA, not this binary).

## Proof

Proven end-to-end 2026-07-01 (cont.63c) on py-feat's bundled `single_face.jpg`: real face → orchestrator → raw fact (AU06=0.918, AU07=1.0, AU12=0.954, gaze/Yaw=6.117, happiness=0.99, conf=0.9997) → the DEPLOYED `progression-evaluator/measure-compute-cli.built.mjs` → `flow-probability=1.1076`, `attentional-stability=1.0`. This verifies py-feat's real output shape matches the authored `affect.au_window` contract (L116).

## Env setup (not package code)

Requires a python3 with `py-feat` installed. py-feat 0.6.2 imports the scipy `simps` symbol removed in scipy≥1.14 — apply the one-line compat shim in `feat/utils/stats.py`: `from scipy.integrate import simpson as simps`. First `Detector()` init downloads detector/AU/emotion models (cached thereafter).

## Dependencies

**Depends on:** `py-feat` (Detector), the descriptor DATA `data/mental-perception/affect-face-tracker-descriptor.json` (ai-command-center) that points the motion-analysis process-job seam here.
**Depended on by:** the passive-perception measures `flow-probability` / `attentional-stability` (progression-evaluator), via the raw `affect.au_window` fact.
