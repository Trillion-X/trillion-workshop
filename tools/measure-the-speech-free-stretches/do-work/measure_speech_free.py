#!/usr/bin/env python3
"""measure_speech_free.py <transcript.json> <clip.wav> [--threshold-s 2.0]: the longest dead-air stretch of a whole clip, one JSON line.

    python3 -I tools/measure-the-speech-free-stretches/do-work/measure_speech_free.py transcript.json clip-16k.wav

A moment is dead air when the transcript has no speech there OR the audio is quiet there (the union of the two): whisper often
runs its word timings straight across a silence, so the transcript alone misses it. Quiet is measured by measure_prosody.py's
own frame levels (quiet_db under the clip's speech level). Nothing is exempt: a music-only replay or end card counts when no
speech is there. Each stretch says which source flagged it: "transcript", "energy", or both.
The transcript is a whisper JSON with "duration" (seconds) and "segments" ({start, end, text}); a blank segment is not speech.
The last line is {"result": {"longest_dead_air_s", "stretches_over_threshold", "threshold_s", "stretches": [{"at_s", "s", "flagged_by"}]}}
or {"error": "what to change"}.
"""
import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np

FRAME_S = 0.01
PROSODY = Path(__file__).resolve().parents[2] / 'compare-voice-and-music-models' / 'do-work' / 'measure_prosody.py'


class Refusal(Exception):
    pass


def prosody_module():
    if not PROSODY.is_file():
        raise Refusal(f'{PROSODY} is missing: the voice comparison tool must be in the Workshop next to this one')
    spec = importlib.util.spec_from_file_location('measure_prosody', PROSODY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def speech_mask(transcript, n):
    spoken = [(float(s['start']), float(s['end'])) for s in transcript['segments'] if str(s.get('text', '')).strip()]
    if not spoken:
        raise Refusal('the transcript has no spoken segment: nothing to measure against')
    mask = np.zeros(n, bool)
    for a, b in spoken:
        mask[int(a / FRAME_S):int(round(b / FRAME_S))] = True
    return mask


def quiet_mask(clip, n):
    mp = prosody_module()
    db = mp.frame_db(mp.load(clip))
    quiet = db < -45.0
    out = np.zeros(n, bool)
    m = min(n, len(quiet))
    out[:m] = quiet[:m]
    out[m:] = True
    return out


def runs(dead, transcript_free, energy_quiet):
    found, i, n = [], 0, len(dead)
    while i < n:
        if dead[i]:
            j = i
            while j < n and dead[j]:
                j += 1
            flagged = []
            if transcript_free[i:j].any():
                flagged.append('transcript')
            if energy_quiet[i:j].any():
                flagged.append('energy')
            found.append((i * FRAME_S, (j - i) * FRAME_S, flagged))
            i = j
        else:
            i += 1
    return found


def measure(transcript, clip, threshold_s=2.0):
    if 'duration' not in transcript or 'segments' not in transcript:
        raise Refusal('the transcript needs "duration" and "segments" (a whisper transcript JSON)')
    n = int(round(float(transcript['duration']) / FRAME_S))
    speech = speech_mask(transcript, n)
    quiet = quiet_mask(clip, n)
    transcript_free = ~speech
    dead = transcript_free | quiet
    found = runs(dead, transcript_free, quiet)
    longest = max([s for _, s, _ in found] or [0.0])
    return {'longest_dead_air_s': round(longest, 2),
            'stretches_over_threshold': sum(1 for _, s, _ in found if s > threshold_s),
            'threshold_s': threshold_s,
            'stretches': [{'at_s': round(a, 2), 's': round(s, 2), 'flagged_by': f} for a, s, f in found]}


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('transcript')
    ap.add_argument('clip')
    ap.add_argument('--threshold-s', type=float, default=2.0)
    a = ap.parse_args(argv)
    try:
        with open(a.transcript) as f:
            transcript = json.load(f)
        print(json.dumps({'result': measure(transcript, a.clip, a.threshold_s)}))
        return 0
    except (Refusal, OSError, ValueError) as e:
        print(json.dumps({'error': str(e)}))
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
