"""sound-harsh: no scratchy, grating or unpleasant effect, unless the moment needs that feeling on purpose.
The first window_s of each effect in the video's own effect track is read. It is harsh when more than
max_hf_share of its energy lies above hf_hz and its spectral centroid is above max_centroid_hz: the scratch of a pen, a click, a screech. A harsh
effect passes only when the spec declares the purpose in `harsh_sound_purpose: {<kind>: <why>}` (at least min_purpose_chars of reason), and is then reported as a note.
A video with no added sound is an empty set."""
import numpy as np

from .. import sfx
from ..report import Finding

EMPTY_SET = 'no added sound'
NAME = 'sound-harsh'


def needs(ctx):
    if ctx.plain:
        return EMPTY_SET      # a pure cut: no overlay, no spec events, nothing added
    if not ctx.overlay or not ctx.timeline:
        return 'no overlay.mov and timeline.json'
    if not sfx.events(ctx) or sfx.samples(ctx) is None:
        return 'no added sound effects in the render'
    return None


def roughness(seg, sr, hf_hz):
    """(share of energy above hf_hz, spectral centroid in Hz) of one effect."""
    w = seg * np.hanning(len(seg))
    power = np.abs(np.fft.rfft(w)) ** 2
    freq = np.fft.rfftfreq(len(w), 1 / sr)
    total = power.sum() + 1e-12
    return float(power[freq > hf_hz].sum() / total), float((freq * power).sum() / total)


def bright_click(seg, sr, c):
    """True for a sharp, bright tick far above its own body (peak over c['click_min_crest'] times the RMS, with at least click_min_hf_share of its energy above
    click_hf_hz): the scratch-and-tap of a pen. Measured on the span up to the next sound (at most click_window_s) so the next effect does not dilute it."""
    if len(seg) < 1024:
        return False, 0.0, 0.0
    crest = float(np.abs(seg).max() / (np.sqrt((seg ** 2).mean()) + 1e-9))
    hf, _ = roughness(seg, sr, c['click_hf_hz'])
    return crest >= c['click_min_crest'] and hf >= c['click_min_hf_share'], crest, hf


def run(ctx):
    c = ctx.cfg['sound_harsh']
    x, sr, source = sfx.effects(ctx)
    evs = sfx.events(ctx)
    t0 = ctx.overlay_t0 or 0.0
    purposes = ctx.spec.get(c['purpose_key']) or {}
    out, checked = [], 0
    for k, e in enumerate(evs):
        seg = sfx.window(x, sr, e['t'], c['window_s'])
        if len(seg) < 1024 or sfx.peak_db(seg) < c['min_peak_db']:
            continue
        checked += 1
        hf, centroid = roughness(seg, sr, c['hf_hz'])
        nxt = evs[k + 1]['t'] if k + 1 < len(evs) else e['t'] + c['click_window_s']
        click, crest, click_hf = bright_click(sfx.window(x, sr, e['t'], min(max(nxt - e['t'], 0.15), c['click_window_s'])), sr, c)
        if (hf > c['max_hf_share'] and centroid > c['max_centroid_hz']) or click:
            why = str(purposes.get(e['kind'], '')).strip()
            if len(why) >= c['min_purpose_chars']:
                out.append(Finding(NAME, 'INFO', f'"{e["kind"]}" is harsh ({hf:.0%} of its energy above {c["hf_hz"] / 1000:g} kHz, centroid {centroid:.0f} Hz) but declared on purpose: {why}', t0 + e['t']))
            else:
                tick = f', a bright tick {crest:.0f}x its body' if click else ''
                out.append(Finding(NAME, 'FAIL', f'"{e["kind"]}" is a scratchy, grating sound ({hf:.0%} of its energy above {c["hf_hz"] / 1000:g} kHz, centroid {centroid:.0f} Hz{tick}); pick a pleasant '
                                   f'sound for the same action, or declare the purpose in the spec ({c["purpose_key"]})', t0 + e['t'], data={'hf_share': hf, 'centroid_hz': centroid, 'kind': e['kind']}))
    return out or [Finding(NAME, 'INFO', f'{checked} effects measured on {source}; none above {c["max_hf_share"]:.0%} high-band energy with a bright centroid')]
