# bio/ — Bio-HRV perception process-job (Apeak passive-perception SOURCE, 2nd modality)

The second real producer of the Apeak passive-perception lane (sibling to `affect/`): an ECG/PPG signal window → NeuroKit2 → a RAW self-describing `bio.hrv_window` fact. Same emit-raw-derive-downstream pattern as the affect + court-ball trackers (the tracker emits raw HRV metrics; downstream measures derive calm/recovery/flow). Its `source: bio-hrv-neurokit2` tag makes it an independent corroborating modality — face + HRV = the ≥2 quorum the fail-closed readout gate needs, from two REAL modalities.

## Files

| File | Purpose |
|------|---------|
| `bio_hrv_emit.py` | Runs NeuroKit2 (`ecg_process` → `hrv_time`) on an ECG/PPG window and emits one raw `bio.hrv_window` fact per window (RMSSD/SDNN/pNN50/MeanNN in ms + signal-quality confidence + provenance). Fail-closed: unprocessable window / no RMSSD → no fact. |
| `README.md` | This file. |

## Key Functions

| Function | Signature / Shape | Role |
|----------|-------------------|------|
| `hrv_facts(signal, rate, windows)` | `(seq, int, int) -> list[fact]` | Split signal into N windows; NeuroKit2 HRV per window → raw facts |
| `_load_signal(path, rate)` | `(str\|None, int) -> (seq, rate)` | Load a CSV signal, or NeuroKit2's bundled resting ECG via `--sample` |
| `main(argv)` | `bio_hrv_emit.py [signal.csv|--sample] [--rate HZ] [--windows N] [--out file]` | CLI entry; prints the fact batch JSON |

## Emitted fact contract (raw, self-describing)

```json
{ "id": "bio.hrv_window:<src>:<w>", "kind": "bio.hrv_window", "source": "bio-hrv-neurokit2",
  "rmssd": 38.84, "sdnn": 49.04, "pnn50": 13.2, "mean_nn": <ms>,
  "confidence": <mean ECG quality>, "window": {"index":0,"rate_hz":100},
  "provenance": {"model":"NeuroKit2","modality":"bio-hrv"} }
```

RMSSD is in **milliseconds** — the downstream `flow-probability` measure normalizes it (`rmssd/(rmssd+scale)`); a raw ms value would blow flow past 1 (real-units bug caught cont.63f).

## Proof

Proven cont.63f on NeuroKit2's bundled resting ECG: signal → orchestrator → real fact (rmssd=38.84ms, sdnn=49.04, conf=0.957) → the DEPLOYED measure/materializer → `state=readout` from TWO real modalities (py-feat face + NeuroKit2 HRV), flow=0.4251 (bounded), attention=0.964 "Locked in".

## Env setup (not package code)

Requires a python3 with `neurokit2` installed. Its install may bump numpy to 2.x which breaks the pywt/py-feat/torch stack — pin `numpy<2` (1.26.4 proven). `--sample` needs no wearable (uses NeuroKit2's bundled ECG).

## Dependencies

**Depends on:** `neurokit2`, the descriptor DATA `data/mental-perception/bio-hrv-tracker-descriptor.json`.
**Depended on by:** `flow-probability` (progression-evaluator) via the raw `bio.hrv_window.rmssd`; the corroboration gate (as the `bio-hrv-neurokit2` modality).
