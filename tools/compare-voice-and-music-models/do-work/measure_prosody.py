#!/usr/bin/env python3
"""measure_prosody.py <clip.wav> [...] [--reference wav] [--no-voice-model]: how a spoken clip is delivered, one JSON line per clip.

  energy      scaled so the 90th-percentile 10 ms frame is -20 dBFS first; speech = frames at or above quiet_db (-45 dBFS)
  pauses      every silence of pause_least_s (0.12 s) or more inside the speech, with its start and length
  pace        speech seconds (first to last loud frame), articulation seconds (speech minus its pauses)
  pitch       F0 by librosa.pyin (60-400 Hz) over voiced frames: 5th-95th percentile in Hz, span in semitones,
              standard deviation in semitones, and within-phrase movement (mean absolute semitone change per 100 ms,
              phrases split at the pauses)
  emphasis    dB spread of voiced frames (p90 minus p10) and their standard deviation
  same_voice  cosine of a pyannote speaker embedding (say_a_line_in_kokoro.DEFAULTS speaker_model) against --reference,
              the cloned voice's recording; omitted with --no-voice-model
The last line of output is {"result": {"clips": [...]}} or {"error": "what to change"}.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import say_a_line_in_kokoro as kt  # noqa: E402  (DEFAULTS and the Refusal class, shared with measure_takes.py)

SR = 16000
HOP = 160  # 10 ms at 16 kHz
SPEECH_DB = -20.0  # each clip is scaled so its 90th-percentile 10 ms frame is at this level (a click cannot set it)


def frame_db(y):
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(y, (80, 80)), 160)[::HOP]
    return 20 * np.log10(np.sqrt(np.mean(frames ** 2, axis=1)) + 1e-9)


def load(path):
    import librosa
    y, _ = librosa.load(path, sr=SR, mono=True)
    level = np.percentile(frame_db(y), 90)
    return y * 10 ** ((SPEECH_DB - level) / 20)


def pauses_and_speech(db, quiet_db=-45.0, least_s=0.12):
    loud = np.where(db >= quiet_db)[0]
    if not len(loud):
        raise kt.Refusal('the clip is silent: nothing is louder than quiet_db')
    first, last = loud[0], loud[-1]
    quiet = db < quiet_db
    pauses, i = [], first
    while i < last:
        if quiet[i]:
            j = i
            while j < last and quiet[j]:
                j += 1
            if (j - i) * 0.01 >= least_s:
                pauses.append({'at_s': round(i * 0.01, 2), 's': round((j - i) * 0.01, 2)})
            i = j
        else:
            i += 1
    return pauses, first, last


def measure(path, reference_emb=None, cfg=kt.DEFAULTS):
    y = load(path)
    db = frame_db(y)
    pauses, first, last = pauses_and_speech(db, cfg.get('quiet_db', -45.0), cfg.get('pause_least_s', 0.12))
    speech_s = (last - first) * 0.01
    silent_s = sum(p['s'] for p in pauses)
    import librosa
    f0, voiced, _ = librosa.pyin(y[first * HOP: last * HOP + HOP], fmin=60, fmax=400, sr=SR,
                                 frame_length=1024, hop_length=HOP)
    keep = voiced & ~np.isnan(f0)
    if keep.sum() < 10:
        raise kt.Refusal(f'{Path(path).name}: fewer than 10 voiced frames; the clip is too quiet or too short for F0')
    hz = f0[keep]
    st = 12 * np.log2(hz / np.median(hz))
    semis = np.full(len(f0), np.nan)
    semis[keep] = st
    pause_mask = np.zeros(len(f0), dtype=bool)
    for p in pauses:
        a = int(round((p['at_s'] - first * 0.01) * 100))
        b = a + int(round(p['s'] * 100))
        pause_mask[max(0, a):max(0, b)] = True
    moves = []
    prev = None
    for k in range(len(semis)):
        if pause_mask[k] or np.isnan(semis[k]):
            prev = None
            continue
        if prev is not None:
            moves.append(abs(semis[k] - prev))
        prev = semis[k]
    voiced_db = db[first:last + 1]
    voiced_db = voiced_db[voiced_db >= cfg.get('quiet_db', -45.0)]
    out = {
        'clip': Path(path).name,
        'seconds': round(len(y) / SR, 2),
        'speech_s': round(speech_s, 2),
        'articulation_s': round(speech_s - silent_s, 2),
        'pauses_n': len(pauses),
        'pauses': pauses,
        'pause_total_s': round(silent_s, 2),
        'f0_p5': round(float(np.percentile(hz, 5)), 1),
        'f0_p95': round(float(np.percentile(hz, 95)), 1),
        'f0_span_st': round(float(12 * np.log2(np.percentile(hz, 95) / np.percentile(hz, 5))), 2),
        'f0_sd_st': round(float(np.std(st)), 2),
        'move_st_per_100ms': round(float(np.mean(moves)), 3) if moves else None,
        'energy_p90_minus_p10_db': round(float(np.percentile(voiced_db, 90) - np.percentile(voiced_db, 10)), 2),
        'energy_sd_db': round(float(np.std(voiced_db)), 2),
    }
    if reference_emb is not None:
        e = reference_emb(path)
        out['same_voice'] = round(float(np.dot(e, reference_emb.ref) / (np.linalg.norm(e) * np.linalg.norm(reference_emb.ref))), 3)
    return out


def make_embedder(reference, cfg=kt.DEFAULTS):
    import torch
    from pyannote.audio import Inference, Model
    emb = Inference(Model.from_pretrained(cfg['speaker_model']), window='whole')

    def embed(p):
        import librosa
        y, _ = librosa.load(p, sr=16000, mono=True)
        return emb({'waveform': torch.from_numpy(y)[None], 'sample_rate': 16000})
    embed.ref = embed(reference)
    return embed


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('clips', nargs='+')
    ap.add_argument('--reference')
    ap.add_argument('--no-voice-model', action='store_true')
    a = ap.parse_args(argv)
    try:
        embed = None
        if not a.no_voice_model:
            if not a.reference:
                raise kt.Refusal('pass --reference (the cloned voice recording) or --no-voice-model')
            embed = make_embedder(a.reference)
        rows = []
        for p in a.clips:
            if not Path(p).is_file():
                raise kt.Refusal(f'{p} is not there: pass the clips to measure')
            rows.append(measure(p, embed))
            print(json.dumps(rows[-1]), flush=True)
    except kt.Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2
    print(json.dumps({'result': {'clips': rows}}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
