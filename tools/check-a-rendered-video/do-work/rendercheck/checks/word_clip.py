"""word-clip: no insert or cut starts or ends inside a word. Two independent witnesses: the sound itself
(is the speaker still voiced at the instant the audio stops, or already voiced when it starts) and word timings from
speech-to-text (whisper on the video; the source footage's own word timings when given)."""
import numpy as np

from ..report import Finding

NAME = 'word-clip'


def needs(ctx):
    if not ctx.info['has_audio']:
        return 'video has no audio'
    if not ctx.can_get_words():
        return 'no word timings: pass --words FILE or install mlx-whisper'
    return None


def boundaries(ctx):
    """(t, role, label): role 'end' = audio stops at t, 'start' = audio resumes at t."""
    out = [(0.0, 'start', 'preview start'), (ctx.info['duration'], 'end', 'preview end')]
    for j in ctx.joins():
        if j['kind'] == 'cut':
            out += [(j['t'], 'end', f'cut at {j["t"]:.2f}s (kept clip ends)', j['src_end']), (j['t'], 'start', f'cut at {j["t"]:.2f}s (next clip starts)')]
        elif j['kind'] == 'hold-entry':
            out.append((j['t'], 'end', f'hold entry at {j["t"]:.2f}s'))
        else:
            out.append((j['t'], 'start', f'hold exit at {j["t"]:.2f}s'))
    return out


def envelope(ctx):
    a, sr = ctx.audio()
    hop = ctx.cfg['word_clip']['envelope_hop_s']
    n = int(len(a) / (hop * sr))
    x = a[:n * int(hop * sr)].reshape(n, -1)
    return 20 * np.log10(np.sqrt((x ** 2).mean(axis=1)) + 1e-9), hop


def _level(env, hop, t0, t1):
    i0, i1 = max(int(t0 / hop), 0), max(int(np.ceil(t1 / hop)), 0)
    seg = env[i0:i1]
    return float(seg.mean()) if len(seg) else -120.0


def _word_at(words, t, tol):
    for w in words:
        if w['s'] + tol < t < w['e'] - tol:
            return w
    return None


def _speakers_own_stop(ctx, src_t):
    """True when the source footage's own words already stop at src_t: a word ends within own_stop_tol_s of it and the next word starts own_stop_gap_s or more later.
    The cut then keeps the sound exactly as the source left it (where the recording died, say) and introduces no new abrupt stop. Needs the spec's source_words."""
    c = ctx.cfg['word_clip']
    words = ctx.source_words or []
    for k, w in enumerate(words):
        if abs(w['e'] - src_t) <= c['own_stop_tol_s']:
            nxt = words[k + 1]['s'] if k + 1 < len(words) else float('inf')
            return nxt - w['e'] >= c['own_stop_gap_s']
    return False


def _audio_findings(ctx, env, hop):
    c = ctx.cfg['word_clip']
    voiced = max(float(np.percentile(env, 90)) - c['voiced_below_peak_db'], c['voiced_floor_db'])
    win = c['edge_window_s']
    words = ctx.preview_words()
    out = []
    for t, role, label, *src in boundaries(ctx):
        edge = label.startswith('preview')
        near = _word_at(words, t, c['tolerance_s'])
        word_txt = f' (heard as "{near["w"]}" {near["s"]:.2f}-{near["e"]:.2f}s)' if near else ''
        pre, post = _level(env, hop, t - win, t), _level(env, hop, t, t + win)
        if role == 'end':
            if pre >= voiced and pre - post >= c['abrupt_drop_db'] and src and _speakers_own_stop(ctx, src[0]):
                out.append(Finding(NAME, 'INFO', f'{label}: audio stops while voiced ({pre:.0f} dB to {post:.0f} dB), but the source footage already stops there (a word ends at {src[0]:.2f}s and nothing is said for '
                                   f'{c["own_stop_gap_s"]:g}s+ after it): this is an edge of the source footage, not one this edit made{word_txt}', t, data={'pre_db': pre, 'post_db': post, 'own_stop': True}))
            elif pre >= voiced and pre - post >= c['abrupt_drop_db']:
                msg = f'{label}: audio stops abruptly while still voiced ({pre:.0f} dB just before, {post:.0f} dB just after){word_txt}'
                out.append(Finding(NAME, 'INFO' if edge else 'FAIL', msg + ('; window edge, not an edit point' if edge else ''), t,
                                   data={'pre_db': pre, 'post_db': post}))
            elif near and not edge:
                out.append(Finding(NAME, 'WARN', f'{label}: lands inside a word{word_txt}; sound is already quiet, check by ear', t))
            continue
        first = next((k for k in range(int(t / hop), len(env)) if env[k] >= voiced), None)
        lead = (first * hop - t) if first is not None else None
        if post >= c['voiced_floor_db'] and post - pre >= c['abrupt_drop_db'] and (post >= voiced or near):
            msg = (f'{label}: speech starts at the join ({pre:.0f} dB just before, {post:.0f} dB just after; '
                   f'needs {c["min_lead_s"] * 1000:.0f} ms of quiet ahead of the first word){word_txt}')
            out.append(Finding(NAME, 'INFO' if edge else 'FAIL', msg + ('; window edge, not an edit point' if edge else ''), t,
                               data={'pre_db': pre, 'post_db': post, 'lead_s': lead}))
        elif lead is not None and lead < c['min_lead_s'] and not edge:
            out.append(Finding(NAME, 'WARN', f'{label}: speech is sounding {lead * 1000:.0f} ms after the start (wants {c["min_lead_s"] * 1000:.0f} ms ahead of the first word){word_txt}', t,
                               data={'lead_s': lead}))
        elif near and not edge:
            out.append(Finding(NAME, 'WARN', f'{label}: lands inside a word{word_txt}; sound is quiet there, check by ear', t))
    return out


def _source_findings(ctx):
    c = ctx.cfg['word_clip']
    words = [x for x in ctx.source_words if x['e'] - x['s'] <= c['max_trusted_word_s']]
    out = []
    pts = []
    for j in ctx.joins():
        if j['src_end'] is not None:
            pts.append((j['src_end'], 'end', f'{j["kind"]} at {j["t"]:.2f}s'))
        if j['src_start'] is not None:
            pts.append((j['src_start'], 'start', f'{j["kind"]} at {j["t"]:.2f}s'))
    for st, role, label in pts:
        w = _word_at(words, st, c['tolerance_s'])
        if w:
            what = 'starts' if role == 'start' else 'ends'
            out.append(Finding(NAME, 'WARN', f'{label}: {what} inside the word "{w["w"]}" of the source footage (word {w["s"]:.2f}-{w["e"]:.2f}s, cut point at {st:.2f}s)', None,
                               data={'source_t': st}))
            continue
        if role == 'start':
            nxt = next((x for x in words if x['s'] >= st - c['tolerance_s']), None)
            if nxt and 0 <= nxt['s'] - st < c['min_lead_s']:
                out.append(Finding(NAME, 'WARN', f'{label}: starts only {(nxt["s"] - st) * 1000:.0f} ms before "{nxt["w"]}" in the source footage (needs {c["min_lead_s"] * 1000:.0f} ms)', None))
        else:
            prv = next((x for x in reversed(words) if x['e'] <= st + c['tolerance_s']), None)
            if prv and 0 <= st - prv['e'] < c['min_lead_s']:
                out.append(Finding(NAME, 'WARN', f'{label}: ends only {(st - prv["e"]) * 1000:.0f} ms after "{prv["w"]}" in the source footage (needs {c["min_lead_s"] * 1000:.0f} ms)', None))
    return out


def run(ctx):
    env, hop = envelope(ctx)
    out = _audio_findings(ctx, env, hop)
    if ctx.source_words:
        out += _source_findings(ctx)
    if not out:
        n = len(boundaries(ctx))
        return [Finding(NAME, 'INFO', f'{n} audio boundaries checked against the sound' + (' and the source footage\'s words' if ctx.source_words else '') + '; none inside a word')]
    return sorted(out, key=lambda f: (f.t is None, f.t or 0))
