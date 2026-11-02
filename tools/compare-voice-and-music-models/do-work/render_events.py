# Render muscriptor JSON note events to a plain test WAV (sine partials, noise bursts for drums) so earshot can
# measure what a MIDI transcription sounds like when played back. Test-only: this is code-made audio, never a film sound.
# usage: python -I render_events.py events.json out.wav
import json, sys
import numpy as np, soundfile as sf
SR = 48000
ev = json.load(open(sys.argv[1]))
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
sf.write(sys.argv[2], np.stack([out, out], 1), SR, subtype='PCM_24')
print(sys.argv[2], f'{dur:.1f} s', len(starts), 'events')
