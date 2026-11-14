# prosody/ — Prosody (voice) perception process-job (Apeak passive-perception SOURCE, 3rd modality)

The third real producer of the Apeak passive-perception lane (sibling to `affect/`, `bio/`): an audio window (between-point self-talk) → librosa acoustic features → a RAW self-describing `affect.prosody_window` fact. Same emit-raw-derive-downstream pattern (the tracker emits raw prosody; the `effort-spike` measure bands arousal → calm/engaged/over_pressing). Its `source: affect-prosody-librosa` tag makes it an independent corroborating modality — face + HRV + prosody = a 3-real-modality readout.

## Files

| File | Purpose |
|------|---------|
| `prosody_arousal_emit.py` | Runs librosa (RMS energy + pyin F0 + onset rate) on an audio window and emits one raw `affect.prosody_window` fact per window (bounded [0,1] arousal + raw f0/energy/speech_rate + voicing confidence). Fail-closed: too little voiced speech → no fact. |
| `README.md` | This file. |

## Key Functions

| Function | Signature / Shape | Role |
|----------|-------------------|------|
| `prosody_facts(audio, sr, windows)` | `(str, int, int) -> list[fact]` | librosa features per window → bounded arousal → raw facts |
| `main(argv)` | `prosody_arousal_emit.py <audio> [--rate HZ] [--windows N] [--out file]` | CLI entry; prints the fact batch JSON |

## Emitted fact contract (raw, self-describing)

```json
{ "id": "affect.prosody_window:<src>:<w>", "kind": "affect.prosody_window", "source": "affect-prosody-librosa",
  "arousal": 0.591, "valence": null, "f0_hz": 296, "energy": 0.117, "speech_rate": 2.7,
  "confidence": <voicing>, "provenance": {"model":"librosa","modality":"affect-prosody"} }
```

arousal = mean of three bounded [0,1] features (energy + F0 + speech-rate, each mapped by a provisional reference range = DATA) — the acoustic-arousal basis m5 names (Banse & Scherer). Bounded in the producer (like emotion2vec emits a bounded arousal). valence is null — it needs an emotion model (emotion2vec).

## Which model is DATA

emotion2vec (HF: `emotion2vec/emotion2vec_plus_large`) is the **preferred** model (emits arousal/valence directly) — install `funasr` to use it. The librosa extractor here is the currently-runnable implementation of the SAME modality using the SAME acoustic features. Selectable via the descriptor DATA (`data/mental-perception/prosody-tracker-descriptor.json`).

## Proof

Proven cont.63g on real speech (gradio `recording1.wav`): audio → orchestrator → real fact (arousal=0.591, f0=296Hz, conf=0.652) → `effort-spike` → "engaged"; full 3-modality readout (face + HRV + prosody, all real) → `state=readout`, flow=0.4251, attention=0.964 "Locked in", effort "engaged".

## Env setup (not package code)

Requires a python3 with `librosa` (numpy<2, shared with the py-feat/neurokit2 stack). No mic needed for a proof (any speech .wav).

## Dependencies

**Depends on:** `librosa`, the descriptor DATA `data/mental-perception/prosody-tracker-descriptor.json`.
**Depended on by:** `effort-spike` (progression-evaluator) via `affect.prosody_window.arousal`; the corroboration gate (as the `affect-prosody-librosa` modality).
