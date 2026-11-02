"""Render a music transcription's JSON note events to a plain test WAV (sine partials for notes, noise bursts for drums)
so an audio meter such as earshot can measure what the transcription sounds like when played back. Test-only: this is
code-made audio for comparing music models, never a sound for a finished piece.

usage: python3 -I render_note_events.py <events.json> <out.wav>

events.json is a list of events: {"type": "start", "pitch": <MIDI note>, "start_time": <s>, "index"?: <n>,
"instrument"?: ...}, {"type": "end", "start_event_index": <n>, "end_time": <s>}, and {"type": "drum", "start_time": <s>}.
A start's index is its "index", else its place in the list; a start with no end lasts 0.3 s. Writes a 48 kHz 24-bit
stereo WAV peaking at half scale, lasting one second past the last note, and prints a last line {"result": {...}} or
{"error": "what to change"}.
"""
import json, sys

SR = 48000


def render(ev):
    """(samples, seconds, events rendered) for a list of note events."""
    import numpy as np
    ends = {e['start_event_index']: e['end_time'] for e in ev if e['type'] == 'end'}
    starts = [(i, e) for i, e in enumerate(ev) if e['type'] in ('start', 'drum')]
    dur = max([ends.get(e.get('index', i), e.get('start_time', 0) + 0.2) for i, e in starts] + [1]) + 1.0
    out = np.zeros(int(dur * SR))
    rng = np.random.default_rng(0)
    for i, e in starts:
        t0 = e['start_time']; a = int(t0 * SR)
        if e['type'] == 'drum' or e.get('instrument') == 'drums':
            n = int(0.12 * SR); seg = rng.standard_normal(n) * np.exp(-np.arange(n) / (0.025 * SR)) * 0.25
        else:
            t1 = ends.get(e.get('index', i), t0 + 0.3); n = max(int((t1 - t0) * SR), 64)
            f = 440 * 2 ** ((e['pitch'] - 69) / 12); t = np.arange(n) / SR
            seg = sum(np.sin(2 * np.pi * f * k * t) / k ** 2 for k in (1, 2, 3)) * 0.08
            env = np.minimum(1, t / 0.01) * np.exp(-t / 1.5); env[-min(n, 480):] *= np.linspace(1, 0, min(n, 480)); seg = seg * env
        b = min(a + len(seg), len(out)); out[a:b] += seg[:b - a]
    out = out / max(1e-9, np.abs(out).max()) * 0.5
    return out, dur, len(starts)


def main(argv):
    if len(argv) != 2:
        print(json.dumps({'error': 'pass <events.json> <out.wav>'}))
        return 2
    try:
        import numpy as np, soundfile as sf
    except ImportError as e:
        print(json.dumps({'error': f'needs numpy and soundfile ({e.name} is missing): python3 -m pip install -U numpy soundfile'}))
        return 2
    try:
        with open(argv[0]) as f:
            ev = json.load(f)
        out, dur, count = render(ev)
    except OSError:
        print(json.dumps({'error': f'{argv[0]} is not there: pass the transcription\'s JSON note events'}))
        return 2
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        print(json.dumps({'error': f'{argv[0]} is not a list of note events ({type(e).__name__}: {e}): each needs type and start_time; a start needs pitch, an end start_event_index and end_time'}))
        return 2
    sf.write(argv[1], np.stack([out, out], 1), SR, subtype='PCM_24')
    print(argv[1], f'{dur:.1f} s', count, 'events')
    print(json.dumps({'result': {'wav': argv[1], 'seconds': round(dur, 3), 'events': count, 'sample_rate': SR}}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
