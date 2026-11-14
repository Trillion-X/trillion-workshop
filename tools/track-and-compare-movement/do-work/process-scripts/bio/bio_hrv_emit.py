#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/bio/bio_hrv_emit.py
#
# =============================================================================
# Apeak passive-perception SOURCE — the bio-HRV tracker as a process-job.
# =============================================================================
# The 2nd real producer of the passive-perception lane (sibling to affect/): a
# raw ECG/PPG signal window -> NeuroKit2 -> a RAW self-describing `bio.hrv_window`
# fact {rmssd, sdnn, pnn50, mean_nn (ms), confidence (signal quality), source,
# provenance}. Same emit-raw-derive-downstream pattern as the affect + court-ball
# trackers (L089): the tracker emits RAW HRV metrics; downstream MEASURES derive
# calm/recovery/flow contributions (progression-evaluator DATA) — the tracker
# computes no product measure. Its `source: bio-hrv-neurokit2` tag makes it an
# INDEPENDENT corroborating modality (face + HRV -> the >=2 quorum the fail-closed
# readout gate requires, without a synthetic fact).
#
# Emits ONE fact per window; a long signal is split into N windows so a multi-
# window read has real between-window variation. Fail-closed: too few beats / bad
# signal quality -> emit nothing (never a fabricated fact); confidence = mean
# ECG quality so the corroboration gate can reject low-quality single-channel reads.
#
# Usage: bio_hrv_emit.py [signal.csv|--sample] [--rate HZ] [--windows N] [--out file]
#   --sample uses NeuroKit2's bundled resting ECG (no wearable needed for a proof).
# =============================================================================
import sys, json, warnings, os
warnings.filterwarnings("ignore")


def _num(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def _load_signal(path, rate):
    import neurokit2 as nk
    if path in (None, "--sample"):
        df = nk.data("bio_resting_5min_100hz")
        col = next((c for c in df.columns if "ECG" in c or "ecg" in c), df.columns[0])
        return df[col].values, 100
    import numpy as np
    vals = np.loadtxt(path, delimiter=",")
    return (vals if vals.ndim == 1 else vals[:, 0]), rate


def hrv_facts(signal, rate, windows, source_name="bio-resting"):
    import neurokit2 as nk
    import numpy as np
    n = max(1, int(windows))
    seg = len(signal) // n
    facts = []
    for w in range(n):
        chunk = signal[w * seg:(w + 1) * seg] if n > 1 else signal
        try:
            signals, info = nk.ecg_process(chunk, sampling_rate=rate)
            hrv = nk.hrv_time(info["ECG_R_Peaks"], sampling_rate=rate, show=False)
            quality = _num(signals["ECG_Quality"].mean()) if "ECG_Quality" in signals else None
        except Exception:
            continue  # fail-closed: unprocessable window -> no fact
        def g(k):
            return _num(hrv[k].iloc[0]) if k in hrv.columns else None
        rmssd = g("HRV_RMSSD")
        if rmssd is None:
            continue  # fail-closed: no usable HRV -> no fact
        facts.append({
            "id": "bio.hrv_window:%s:%d" % (source_name, w),
            "kind": "bio.hrv_window",
            "source": "bio-hrv-neurokit2",  # independent modality tag (corroboration gate)
            "rmssd": rmssd, "sdnn": g("HRV_SDNN"), "pnn50": g("HRV_pNN50"), "mean_nn": g("HRV_MeanNN"),
            "confidence": quality if quality is not None else 0.9,
            "window": {"index": w, "source": source_name, "rate_hz": rate},
            "provenance": {"model": "NeuroKit2", "detector": "nk.ecg_process+hrv_time", "modality": "bio-hrv"},
        })
    return facts


def main(argv):
    path = "--sample"
    rate, windows, out = 100, 1, None
    rest = [a for a in argv]
    if rest and not rest[0].startswith("--"):
        path = rest[0]
    for flag, setter in (("--rate", "rate"), ("--windows", "windows"), ("--out", "out")):
        if flag in rest:
            v = rest[rest.index(flag) + 1]
            if setter == "out":
                out = v
            elif setter == "rate":
                rate = int(v)
            else:
                windows = int(v)
    signal, rate = _load_signal(path if path != "--sample" else None, rate)
    facts = hrv_facts(signal, rate, windows)
    payload = {"fact_kind": "bio.hrv_window", "facts": facts, "count": len(facts)}
    text = json.dumps(payload, indent=2)
    if out:
        with open(out, "w") as f:
            f.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
