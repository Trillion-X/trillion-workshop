"""sound-loops: one recorded sound is not repeated like a loop (for example the same rustle laid down six times, once a second).
A run is the same kind of effect, at least min_repeats times, each next one within max_gap_s of the last, whose renders are copies of each other (peak
normalised cross-correlation of consecutive windows at or above min_copy_corr) and whose sound is longer than min_sound_s of real sound. Short hits (a drum roll
of thumps, ticks of a counter) are rhythm, not a loop, and pass. A spec may declare a run on purpose under `loop_sound_purpose[kind]`.
A video with no added sound is an empty set."""
import numpy as np

from .. import sfx
from ..report import Finding

EMPTY_SET = 'no added sound'
NAME = 'sound-loops'


def needs(ctx):
    if ctx.plain:
        return EMPTY_SET      # a pure cut: no overlay, no spec events, nothing added
    if not ctx.overlay or not ctx.timeline:
        return 'no overlay.mov and timeline.json'
    if not sfx.events(ctx) or sfx.samples(ctx) is None:
        return 'no added sound effects in the render'
    return None


def copy_corr(a, b):
    n = min(len(a), len(b))
    if n < 256:
        return 0.0
    a, b = a[:n] - a[:n].mean(), b[:n] - b[:n].mean()
    r = np.fft.irfft(np.fft.rfft(a, 2 * n) * np.conj(np.fft.rfft(b, 2 * n)))
    return float(r.max() / (np.linalg.norm(a) * np.linalg.norm(b) + sfx.EPS))


def runs(evs, max_gap):
    out, cur = [], []
    for e in evs:
        if cur and e['kind'] == cur[-1]['kind'] and e['t'] - cur[-1]['t'] <= max_gap:
            cur.append(e)
        else:
            out.append(cur)
            cur = [e]
    out.append(cur)
    return out


def run(ctx):
    c = ctx.cfg['sound_loops']
    x, sr = sfx.samples(ctx)
    t0 = ctx.overlay_t0 or 0.0
    purposes = (ctx.spec or {}).get(c['purpose_key'], {}) or {}
    out, checked = [], 0
    for r in runs(sfx.events(ctx), c['max_gap_s']):
        if len(r) < c['min_repeats']:
            continue
        checked += 1
        wins = [sfx.window(x, sr, e['t'], min(c['max_gap_s'], (r[k + 1]['t'] - e['t']) if k + 1 < len(r) else c['max_gap_s'])) for k, e in enumerate(r)]
        copies = [copy_corr(a, b) >= c['min_copy_corr'] for a, b in zip(wins, wins[1:])]
        length = max(sfx.active_s(w, sr) for w in wins[:-1])
        if sum(copies) < c['min_repeats'] - 1 or length <= c['min_sound_s']:
            continue
        kind = r[0]['kind']
        why = str(purposes.get(kind, '')).strip()
        msg = f'"{kind}" is the same {length:.2f} s recording laid down {len(r)} times, {r[1]["t"] - r[0]["t"]:.2f} s apart: it reads as a mechanical loop'
        if len(why) >= c['min_purpose_chars']:
            out.append(Finding(NAME, 'INFO', f'{msg}, declared on purpose: {why}', t0 + r[0]['t']))
        else:
            out.append(Finding(NAME, 'FAIL', f'{msg}; vary the sound (different takes, pitch, level) or declare the purpose in the spec ({c["purpose_key"]})',
                               t0 + r[0]['t'], data={'kind': kind, 'repeats': len(r), 'length_s': length}))
    return out or [Finding(NAME, 'INFO', f'{checked} repeated runs measured; none is a loop of one long recording')]
