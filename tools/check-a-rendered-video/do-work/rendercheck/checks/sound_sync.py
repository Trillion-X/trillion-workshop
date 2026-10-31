"""sound-sync: every sound effect lands on the frame of its event in the delivered video, within 1 frame. Measured on the video's own mixed audio, never on the stem (the stem is right by
construction; a composite can still place the whole stem at video time 0, seconds early).
  - whole stem: the phase-transform correlation (whitened, so the voice does not hide the effects) of the video's effect stem (the first file of sound_mix.stem_names beside the overlay) over the video's
    audio; its peak must lie at the overlay start in the video (edit.overlay.at - edit.preview[0]) within max_offset_frames;
  - each non-silent event: the same correlation of its own stem segment; it fails when the sound is clearly in the video (min_event_over_noise times the noise) but not
    at its expected time (overlay start + timeline t, within a frame: under max_missing_over_noise times the noise there).
A stem with no energy is an empty set; a video whose correlation is too weak to read is not measured (WARN, never a pass)."""
import numpy as np

from .. import media, sfx
from ..report import Finding

NAME = 'sound-sync'
EMPTY_SET = 'no added sound'


def needs(ctx):
    if ctx.plain:
        return EMPTY_SET
    if not ctx.overlay or not ctx.timeline or ctx.overlay_t0 is None:
        return 'no overlay.mov, timeline.json and edit.overlay.at'
    if not sfx.events(ctx) or sfx.samples(ctx) is None:
        return EMPTY_SET
    return None


def phat(sig, tmpl, fmin, sr):
    """Phase-transform cross-correlation of tmpl at every start of sig: the spectra are whitened before they are multiplied, so a wide-band effect stands out sharply under a
    narrow-band voice (the plain normalised correlation of a sparse stem against speech peaks in the wrong place). Below fmin the bins are dropped (voice fundamental)."""
    n = 1 << int(np.ceil(np.log2(len(sig) + len(tmpl))))
    x = np.fft.rfft(sig, n) * np.conj(np.fft.rfft(tmpl, n))
    x /= np.abs(x) + 1e-9
    x[np.fft.rfftfreq(n, 1 / sr) < fmin] = 0
    return np.fft.irfft(x, n)[:len(sig) - len(tmpl) + 1]


def strength(c, k, sr, guard_s):
    """Peak height over the median absolute level of the whole correlation, and over the best peak outside guard_s of it."""
    lo, hi = max(k - int(guard_s * sr), 0), k + int(guard_s * sr) + 1
    rest = np.concatenate([c[:lo], c[hi:]])
    return float(c[k] / (np.median(np.abs(c)) + 1e-12)), float(c[k] / (rest.max() + 1e-12)) if len(rest) else float('inf')


def run(ctx):
    c = ctx.cfg['sound_sync']
    sr = c['sr']
    frame = 1.0 / ctx.fps
    p, _ = media.audio(ctx.preview, sr)
    s, _ = media.audio(sfx.track_path(ctx), sr)
    s = s.astype(np.float64)
    p = np.concatenate([p.astype(np.float64), np.zeros(int(c['pad_s'] * sr))])      # a stem that is late runs past the end of the preview: give it room to be found
    t0 = ctx.overlay_t0
    if np.abs(s).max() < c['min_stem_peak'] or len(p) < len(s) // 2:
        return [Finding(NAME, 'INFO', 'the effect stem is silent or the preview is shorter than it', data={'empty_set': True})]
    out = []
    whole = s[:max(len(p) - 1, 1)]
    cw = phat(p, whole, c['fmin_hz'], sr)
    k = int(np.argmax(cw))
    off = k / sr - t0
    over_noise, over_next = strength(cw, k, sr, c['guard_s'])
    placed = abs(off) <= c['max_offset_frames'] * frame
    if over_noise < c['min_over_noise'] or (over_next < c['min_over_next'] and not placed):      # an ambiguous peak that is not at the overlay start cannot be called early or late
        return [Finding(NAME, 'WARN', f'the effect stem could not be found in the preview audio (peak {over_noise:.1f}x the noise, {over_next:.1f}x the next peak): the sync is not measured',
                        data={'not_measured': True})]
    if abs(off) > c['max_offset_frames'] * frame:
        out.append(Finding(NAME, 'FAIL', f'the effects play {abs(off) * 1000:.0f} ms {"early" if off < 0 else "late"} ({abs(off) / frame:.0f} frames) in the delivered preview: the stem starts at {k / sr:.3f}s, the overlay starts at {t0:.3f}s '
                           f'(limit {c["max_offset_frames"]} frame); the stem must be placed at the overlay start in the preview\'s own audio', 0.0, data={'offset_s': off, 'peak_over_noise': over_noise}))
    evs = sfx.events(ctx)
    ts = [e['t'] for e in evs]
    checked = 0
    for e in evs:
        t = e['t']
        if e['kind'] in c['ambient_kinds']:
            continue      # a room tone has no event edge to land on
        nxt = min([u for u in ts if u > t + 0.05] + [t + c['segment_max_s']])
        seg_len = max(c['segment_min_s'], min(c['segment_max_s'], nxt - t))
        k0 = max(0, int((t - c['lead_s']) * sr))
        tm = s[k0:k0 + int(seg_len * sr)]
        if len(tm) < sr * 0.05 or np.abs(tm).max() < c['min_stem_peak']:
            continue
        ce = phat(p, tm, c['fmin_hz'], sr)
        lead = t - k0 / sr
        exp_i = int((t0 + t - lead) * sr)
        if not 0 <= exp_i < len(ce):
            continue
        best_i = int(np.argmax(ce))
        floor = float(np.median(np.abs(ce))) + 1e-12
        if ce[best_i] / floor < c['min_event_over_noise']:
            continue
        checked += 1
        at_exp = float(ce[max(exp_i - int(frame * sr), 0):exp_i + int(frame * sr) + 1].max())
        if at_exp / floor < c['max_missing_over_noise']:
            out.append(Finding(NAME, 'FAIL', f'"{e["kind"]}" is not in the video at its event time {t0 + t:.3f}s (its sound is {at_exp / floor:.1f}x the noise there) but is {ce[best_i] / floor:.0f}x the noise at {best_i / sr + lead:.3f}s '
                               f'({(best_i - exp_i) / sr * 1000:+.0f} ms, {(best_i - exp_i) / sr / frame:+.0f} frames)', t0 + t, data={'kind': e['kind'], 'offset_s': (best_i - exp_i) / sr}))
    return out or [Finding(NAME, 'INFO', f'stem lands {off * 1000:+.1f} ms from the overlay start (peak {over_noise:.0f}x the noise); {checked} events matched at their time')]
