"""sound-balance: each sound class keeps a consistent, clearly audible level.
Two measures, on the effects as they are in the delivered video (sfx.effects: the video's audio minus the same range without the added sounds, where that is known; otherwise the video's own effect stem, said in the result):
  - an exit sound (slide_out, card_out, word_out, whoosh, tear) is never quieter than the median appear sound of its graphic, the appear sounds since the previous
    exit, by more than exit_tolerance_db (peak level of the loudest window_s after the sound starts);
  - every effect that is not ambient reaches floor_db against the loud part of the voice: its peak against the voice_pct percentile of the video's 50 ms
    envelope within voice_window_s of it (the video audio is the voice with the effects on it). An effect far under the voice cannot be heard on normal speakers.
A video with no added sound is an empty set."""
import numpy as np

from .. import sfx
from ..report import Finding

EMPTY_SET = 'no added sound'
NAME = 'sound-balance'


def needs(ctx):
    if ctx.plain:
        return EMPTY_SET      # a pure cut: no overlay, no spec events, nothing added
    if not ctx.overlay or not ctx.timeline:
        return 'no overlay.mov and timeline.json'
    if not sfx.events(ctx) or sfx.samples(ctx) is None:
        return 'no added sound effects in the render'
    return None


def run(ctx):
    c = ctx.cfg['sound_balance']
    x, sr, source = sfx.effects(ctx)
    evs = sfx.events(ctx)
    t0 = ctx.overlay_t0 or 0.0
    a, asr = ctx.audio()
    env = sfx.envelope_db(a, asr)
    hop = 0.05
    out = []
    for e in evs:
        e['peak'] = sfx.peak_db(sfx.window(x, sr, e['t'], c['window_s']))
    appear, since_exit = set(c['appear_kinds']), []
    for e in evs:
        if e['kind'] in appear:
            since_exit.append(e['peak'])
        elif e['kind'] in c['exit_kinds'] and since_exit:
            ref = float(np.median(since_exit))
            if e['peak'] < ref - c['exit_tolerance_db']:
                out.append(Finding(NAME, 'FAIL', f'the exit sound "{e["kind"]}" peaks at {e["peak"]:.1f} dB, {ref - e["peak"]:.1f} dB under the appear sounds of its graphic '
                                   f'(median {ref:.1f} dB); an exit is never quieter than what appears (limit {c["exit_tolerance_db"]:g} dB)', t0 + e['t'], data={'exit_db': e['peak'], 'appear_db': ref}))
            since_exit = []
    for e in evs:
        if e['kind'] in c['ambient_kinds']:
            continue
        i0, i1 = int((t0 + e['t'] - c['voice_window_s']) / hop), int((t0 + e['t'] + c['voice_window_s']) / hop)
        seg = env[max(i0, 0):i1]
        if not len(seg):
            continue
        voice = float(np.percentile(seg, c['voice_pct']))
        margin = e['peak'] - voice
        e['margin'] = margin
        if margin < c['floor_db']:
            out.append(Finding(NAME, 'FAIL', f'"{e["kind"]}" peaks at {e["peak"]:.1f} dB, {-margin:.1f} dB under the loud part of the voice ({voice:.1f} dB); an effect needs to be '
                               f'within {-c["floor_db"]:g} dB of it to be heard on normal speakers', t0 + e['t'], data={'peak_db': e['peak'], 'voice_db': voice}))
    if out:
        return out
    worst = min((e['margin'] for e in evs if 'margin' in e), default=None)
    return [Finding(NAME, 'INFO', f'{len(evs)} effects, measured on {source}: no exit quieter than its appear sounds' + (f'; the quietest sits {-worst:.1f} dB under the voice (floor {-c["floor_db"]:g} dB)' if worst is not None else ''))]
