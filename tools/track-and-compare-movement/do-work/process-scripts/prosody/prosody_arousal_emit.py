#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/prosody/prosody_arousal_emit.py
#
# =============================================================================
# Apeak passive-perception SOURCE — the prosody (voice) tracker as a process-job.
# =============================================================================
# The 3rd real producer of the passive-perception lane (sibling to affect/, bio/):
# an audio window (between-point self-talk) -> librosa acoustic features -> a RAW
# self-describing `affect.prosody_window` fact {arousal (BOUNDED [0,1]), f0_hz,
# energy, speech_rate, confidence (voicing), source, provenance}. Emit-raw-derive-
# downstream (L089): the `effort-spike` measure BANDS arousal into calm/engaged/
# over_pressing (progression-evaluator DATA). Unlike py-feat (raw AUs), an emotion
# model (emotion2vec) emits arousal DIRECTLY, so this producer plays that role —
# arousal is the bounded acoustic-arousal proxy (energy + F0 + speech-rate, the
# features m5 names; Banse & Scherer). "Which model" is DATA: the descriptor names
# emotion2vec preferred; this librosa extractor is the runnable implementation.
#
# arousal = mean of three bounded features (each mapped to [0,1] by a provisional
# reference range = DATA): louder + higher-pitched + faster speech -> more aroused.
# Fail-closed: too little voiced speech -> emit nothing (can't read prosody from
# silence/noise); confidence = mean voicing probability so the corroboration gate
# can reject low-quality reads (L117).
#
# Usage: prosody_arousal_emit.py <audio> [--rate HZ] [--windows N] [--out file]
# =============================================================================
import sys, json, warnings, os
warnings.filterwarnings("ignore")

# provisional reference ranges (DATA — calibrated by MNT05 / emotion2vec later)
RMS_REF = 0.15          # RMS energy at which energy_norm ~ 0.5 (rms/(rms+ref))
F0_LO, F0_HI = 80.0, 300.0   # speech F0 span (Hz) -> [0,1]
RATE_REF = 5.0          # onsets/sec at which rate_norm ~ 0.5
VOICING_MIN = 0.25      # fail-closed: below this, not enough voiced speech


def _clamp01(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def prosody_facts(audio_path, target_sr, windows):
    import librosa, numpy as np
    y, sr = librosa.load(audio_path, sr=target_sr)
    n = max(1, int(windows))
    seg = len(y) // n
    facts = []
    for w in range(n):
        chunk = y[w * seg:(w + 1) * seg] if n > 1 else y
        if len(chunk) < sr * 0.5:
            continue  # need >= 0.5s
        rms = float(np.mean(librosa.feature.rms(y=chunk)))
        f0, voiced, vprob = librosa.pyin(chunk, fmin=F0_LO, fmax=400.0, sr=sr)
        f0v = f0[~np.isnan(f0)] if f0 is not None else np.array([])
        mean_f0 = float(np.mean(f0v)) if len(f0v) else 0.0
        voicing = float(np.mean(vprob)) if vprob is not None and len(vprob) else 0.0
        if voicing < VOICING_MIN or mean_f0 <= 0:
            continue  # fail-closed: not enough voiced speech
        onset_env = librosa.onset.onset_strength(y=chunk, sr=sr)
        rate = len(librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)) / (len(chunk) / sr)
        # three bounded [0,1] acoustic-arousal features -> arousal is their mean
        energy_norm = _clamp01(rms / (rms + RMS_REF))
        f0_norm = _clamp01((mean_f0 - F0_LO) / (F0_HI - F0_LO))
        rate_norm = _clamp01(rate / (rate + RATE_REF))
        arousal = (energy_norm + f0_norm + rate_norm) / 3.0
        facts.append({
            "id": "affect.prosody_window:%s:%d" % (os.path.basename(audio_path), w),
            "kind": "affect.prosody_window",
            "source": "affect-prosody-librosa",  # modality tag (corroboration gate); emotion2vec = the DATA-named upgrade
            "arousal": arousal, "valence": None,  # valence needs an emotion model (emotion2vec) — honest null
            "f0_hz": mean_f0, "energy": rms, "speech_rate": rate,
            "confidence": voicing,
            "window": {"index": w, "source": os.path.basename(audio_path), "rate_hz": sr},
            "provenance": {"model": "librosa", "detector": "rms+pyin+onset", "modality": "affect-prosody"},
        })
    return facts


def main(argv):
    if not argv or argv[0].startswith("--"):
        print("usage: prosody_arousal_emit.py <audio> [--rate HZ] [--windows N] [--out file]", file=sys.stderr)
        return 2
    audio = argv[0]
    sr, windows, out = 16000, 1, None
    if "--rate" in argv:
        sr = int(argv[argv.index("--rate") + 1])
    if "--windows" in argv:
        windows = int(argv[argv.index("--windows") + 1])
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]
    facts = prosody_facts(audio, sr, windows)
    payload = {"fact_kind": "affect.prosody_window", "facts": facts, "count": len(facts)}
    text = json.dumps(payload, indent=2)
    if out:
        with open(out, "w") as f:
            f.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
