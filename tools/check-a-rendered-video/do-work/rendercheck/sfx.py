"""The added sound effects of one video, read from its overlay render: the effect stem beside the overlay (the first file of config sound_mix.stem_names that exists:
the effects alone when the video has a voice, else the stem as mixed) and the `sounds` list of the timeline (kind, seconds from the overlay's first frame). Shared by the
sound checks (sound-balance, sound-harsh, sound-loops)."""
import os

import numpy as np

from . import media

SR = 22050
EPS = 1e-9


def track_path(ctx):
    if not ctx.overlay:
        return None
    base = os.path.dirname(ctx.overlay)
    for name in ctx.cfg['sound_mix']['stem_names']:
        if os.path.isfile(os.path.join(base, name)):
            return os.path.join(base, name)
    return None


def events(ctx):
    """[{'kind', 't'}] in the overlay's own seconds, in time order; [] when the option has no timeline or no added sound."""
    if not ctx.timeline:
        return []
    return sorted(({'kind': s['kind'], 't': float(s['t'])} for s in ctx.timeline.get('sounds', [])), key=lambda e: e['t'])


def samples(ctx):
    """(mono float samples at SR, SR) of the effect track, cached on the context; None without one."""
    if 'sfx' not in ctx._cache:
        path = track_path(ctx)
        ctx._cache['sfx'] = media.audio(path, SR) if path else None
    return ctx._cache['sfx']


def db(x):
    return float(20 * np.log10(x + EPS))


def peak_db(seg):
    return db(float(np.abs(seg).max())) if len(seg) else -120.0


def rms_db(seg):
    return db(float(np.sqrt((seg ** 2).mean()))) if len(seg) else -120.0


def window(x, sr, t, dur):
    a = max(int(t * sr), 0)
    return x[a:a + int(dur * sr)]


def envelope_db(x, sr, hop_s=0.05):
    n = int(hop_s * sr)
    m = len(x) // n
    if m == 0:
        return np.zeros(0)
    return 20 * np.log10(np.sqrt((x[:m * n].reshape(m, n) ** 2).mean(axis=1)) + EPS)


def active_s(seg, sr, below_db=30.0):
    """Seconds between the first and last 10 ms frame within below_db of the segment's loudest: how long the sound really sounds."""
    env = envelope_db(seg, sr, 0.01)
    if not len(env):
        return 0.0
    live = np.nonzero(env >= env.max() - below_db)[0]
    return float((live[-1] - live[0] + 1) * 0.01) if len(live) else 0.0


def audio_range(path, ss, t):
    """Mono audio at SR of path from ss for t seconds."""
    raw = media._raw(['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{max(ss, 0):.4f}', '-t', f'{t:.4f}', '-i', path, '-vn', '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'])
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def base_audio(ctx):
    """(audio at SR of the same range without the added sounds, label) or None: the video named by the spec's `sound_base` (a path, absolute or beside the video) when it
    exists and has the same duration."""
    cfg = ctx.cfg['sound_mix']
    given = ctx.spec.get('sound_base')
    if not given:
        return None
    cand = given if os.path.isabs(given) else os.path.join(os.path.dirname(ctx.preview), given)
    if os.path.isfile(cand) and abs(media.probe(cand)['duration'] - ctx.info['duration']) <= cfg['duration_tolerance_s']:
        return media.audio(cand, SR)[0], f'sound base {os.path.basename(cand)}'
    return None


def effects(ctx):
    """(samples, SR, label): the effects as they are in the DELIVERED video, in the overlay's own seconds, when the same range without the added sounds is known (spec `sound_base`): the
    video's audio minus the base fitted by least squares in short windows (loudnorm moves the gain through a video). Otherwise the effect stem, labelled as such: the stem
    is right by construction, so a level or roughness read from it says nothing about what the viewer hears (sound-sync checks the stem is in the delivered file at its time)."""
    if 'sfx_mix' in ctx._cache:
        return ctx._cache['sfx_mix']
    cfg = ctx.cfg['sound_mix']
    got = base_audio(ctx) if ctx.overlay_t0 is not None else None
    stem, _ = samples(ctx)
    out = (stem, SR, 'the effect stem (no sound base for this video)')
    if got is not None:
        base, label = got
        p = media.audio(ctx.preview, SR)[0]
        n = min(len(p), len(base))
        win = int(cfg['gain_window_s'] * SR)
        r = np.zeros(n)
        for a in range(0, n, win):
            hi = min(a + win, n)
            pb, bb = p[a:hi].astype(np.float64), base[a:hi].astype(np.float64)
            g = float(np.dot(pb, bb) / (np.dot(bb, bb) + EPS))
            r[a:hi] = pb - g * bb
        below = 10 * np.log10((p[:n].astype(np.float64) ** 2).mean() / ((r ** 2).mean() + 1e-20) + 1e-20)
        if below >= cfg['min_residual_below_db']:
            out = (r[int(ctx.overlay_t0 * SR):].astype(np.float32), SR, f'the delivered mix minus {label}')
    ctx._cache['sfx_mix'] = out
    return out
