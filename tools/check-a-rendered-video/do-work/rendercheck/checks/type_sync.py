"""type-sync: a typed line gets one key sound per character for the whole length of the typing, starting and stopping with
it, never one fixed-length clip laid under it.
Reveal times: for each spec element that types on (a `cps` key), the overlay pixels inside the element's box are followed frame
to frame; the change between frames is the characters appearing, so the n-th visible character is revealed when n / total of
the typing's change has happened. Key onsets: rises in the loudness of the sound-effects stem (the stem named by type_sync.stem_name beside the
overlay). FAIL when a run of `min_run_chars` or more revealed characters has no onset within `tolerance_s` of any of them, or
when the sound is still running more than `max_overrun_s` after the last character."""
import subprocess

import numpy as np

from .. import media
from ..report import Finding

EMPTY_SET = 'no type-on element'      # a needs() reason that means the spec has no element of this kind: reported as a pass, not a skip
NAME = 'type-sync'


def speed(ev, c):
    """Characters per second the event declares (`cps`, or `chars_per_s`), or None."""
    return next((ev[k] for k in c['type_on_keys'] if k in ev), None)


def type_on_events(ctx):
    c = ctx.cfg['type_sync']
    return [ev for ev in ctx.spec.get('events', []) if speed(ev, c) is not None and ev.get('text') and 'pos' in ev]


def undeclared_typing(ctx):
    """Spec events that look like typed text (a typewriter type, or a type-on, typing or key-sound field) but carry no `cps`, so the
    typed-text check would skip them. Listed so the check can say it did not measure them."""
    c = ctx.cfg['type_sync']
    la = c['look_alike']
    return [ev for ev in ctx.spec.get('events', [])
            if speed(ev, c) is None and (ev.get('type') in la['types'] or any(k in ev for k in la['keys']))]


def stem_path(ctx):
    import os
    return os.path.join(os.path.dirname(ctx.overlay), ctx.cfg['type_sync']['stem_name']) if ctx.overlay else None


def needs(ctx):
    if not type_on_events(ctx) and not undeclared_typing(ctx):
        return 'no type-on element (no spec event with a cps key)'       # a fact about the spec: needs no overlay
    return None if ctx.overlay else 'no overlay.mov'


def element_box(ev, c):
    b = c['box']
    x, y = ev['pos']
    size = ev.get('size', 40)
    return (max(0, int(x - b['pad_px'])), max(0, int(y - b['pad_px'])),
            int(len(ev['text']) * size * b['w_per_char_em'] + 2 * b['pad_px']), int(size * b['h_em'] + 2 * b['pad_px']))


def box_frames(overlay, box):
    x, y, w, h = box
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-i', overlay, '-vf', f'crop={w}:{h}:{x}:{y}', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 4).astype(np.int16)


def line_boxes(ctx, ev, lines):
    """One crop box (x, y, w, h) per typed line. A single line: the estimated box of its text. Several lines (a block): the block's box, from timeline.json when the
    renderer recorded one under the event's id, else estimated from the longest line, cut into equal bands, one per line, so each line's keys are followed on its own."""
    c = ctx.cfg['type_sync']
    if len(lines) == 1:
        return [element_box(ev, c)]
    b = c['box']
    x, y = ev['pos']
    size = ev.get('size', 40)
    recorded = next((t['box'] for t in (ctx.timeline or {}).get('boxes', []) if t['id'] == ev.get('id')), None)
    x0, y0, x1, y1 = recorded or (x - b['pad_px'], y - b['pad_px'], x + max(map(len, lines)) * size * b['w_per_char_em'] + b['pad_px'], y + len(lines) * size * b['h_em'] + b['pad_px'])
    x0, y0, x1, y1 = max(0, int(x0)), max(0, int(y0)), min(ctx.cfg['frame']['width'], int(x1)), min(ctx.cfg['frame']['height'], int(y1))
    band = (y1 - y0) / len(lines)
    return [(x0, int(y0 + k * band), x1 - x0, int(band)) for k in range(len(lines))]


def reveal_times(ctx, ev):
    """Seconds (overlay time) at which each non-space character of the element becomes visible, line after line, or None when any line's typing is not found."""
    c = ctx.cfg['type_sync']
    lines = [ln for ln in ev['text'].split('\n') if ln.strip()]
    times, before = [], 0
    for k, (line, box) in enumerate(zip(lines, line_boxes(ctx, ev, lines))):
        lead = before / speed(ev, c) * c['window_factor'] + k * c['window_slack_s']      # a later line starts after the lines above it have typed
        got = line_reveal(ctx, box, line, speed(ev, c), lead)
        before += len(line)
        if got is None:
            return None
        times += got
    return times


def line_reveal(ctx, box, text, cps, lead_s=0.0):
    """Reveal seconds of the non-space characters of one typed line inside its crop box, or None."""
    c = ctx.cfg['type_sync']
    fr = box_frames(ctx.overlay, box)
    fps = ctx.overlay_fps()
    n = len(fr)
    change = np.zeros(n)
    change[1:] = (np.abs(fr[1:] - fr[:-1]).max(axis=3) > c['pixel_delta']).sum(axis=(1, 2))
    area = fr.shape[1] * fr.shape[2]
    appears = change > c['appear_change_frac'] * area
    live = (change > c['min_change_frac'] * area) & ~appears
    letters = sum(1 for ch in text if not ch.isspace())
    window = int((lead_s + len(text) / cps * c['window_factor'] + c['window_slack_s']) * fps)
    start = None
    for a in np.where(appears)[0]:
        if live[a + 1:a + 1 + window].sum() >= c['min_live_frac'] * min(letters, len(text) / cps * fps / c['step_frames']):      # a stop-motion look moves on twos: a frame shows several keys
            start = a + 1 + int(np.argmax(live[a + 1:]))
            break
    if start is None:
        return None
    end = start
    for i in np.where(live)[0]:
        if i < start:
            continue
        if (i - end) / fps > c['max_gap_s']:
            break
        end = i
    seg = change[start:end + 1] * live[start:end + 1]
    progress = np.cumsum(seg) / seg.sum()
    times = []
    for k in range(letters):
        hit = int(np.argmax(progress >= (k + 0.5) / letters))
        times.append((start + hit) / fps)
    return times


def onsets(ctx, t_from, t_to):
    """Key onsets and the end of the sound that runs on after t_to, from the loudness of the effects stem."""
    c = ctx.cfg['type_sync']
    a, sr = media.audio(stem_path(ctx))
    hop = int(sr * c['hop_s'])
    env = np.sqrt((a[:len(a) // hop * hop].reshape(-1, hop) ** 2).mean(axis=1))
    t = np.arange(len(env)) * c['hop_s']
    rise = np.zeros_like(env)
    rise[1:] = env[1:] - env[:-1]
    out, last = [], -1.0
    for i in np.where((env >= c['onset_floor']) & (rise >= c['onset_rise']) & (t >= t_from - c['tolerance_s']) & (t <= t_to + 1.5))[0]:
        if t[i] - last >= c['refractory_s']:
            out.append(float(t[i]))
            last = t[i]
    quiet_for = int(c['tail_silence_s'] / c['hop_s'])
    j = int(t_to / c['hop_s'])
    end = t_to
    k = j
    while k < len(env):
        if env[k] >= c['onset_floor']:
            end = t[k]
        elif k - int(end / c['hop_s']) >= quiet_for:
            break
        k += 1
    return out, float(end)


def run(ctx):
    c = ctx.cfg['type_sync']
    import os
    if not os.path.isfile(stem_path(ctx)) and type_on_events(ctx):
        return [Finding(NAME, 'WARN', f'no {c["stem_name"]} beside the overlay, so key sounds are not measured', data={'not_measured': True})]
    t0 = ctx.overlay_t0 or 0.0
    out = [Finding(NAME, 'WARN', f'{ev["type"]} "{ev.get("id")}" looks like typed text but has no {c["type_on_keys"][0]} (characters per second) in the spec, so its key sounds are not measured; '
                   f'declare {c["type_on_keys"][0]} on it', data={'not_measured': True}) for ev in undeclared_typing(ctx)]
    for ev in type_on_events(ctx):
        times = reveal_times(ctx, ev)
        label = f'{ev["type"]} "{ev.get("id")}"'
        if not times:
            out.append(Finding(NAME, 'WARN', f'{label}: typing not found in the overlay pixels, so its key sounds are not measured', data={'not_measured': True}))
            continue
        keys, tail_end = onsets(ctx, times[0], times[-1])
        matched = [any(abs(k - t) <= c['tolerance_s'] for k in keys) for t in times]
        i, bad = 0, False
        while i < len(times):
            if matched[i]:
                i += 1
                continue
            j = i
            while j < len(times) and not matched[j]:
                j += 1
            if j - i >= c['min_run_chars']:
                bad = True
                text = [ch for ch in ev['text'] if not ch.isspace()]
                out.append(Finding(NAME, 'FAIL', f'{label}: no key sound within {c["tolerance_s"] * 1000:.0f} ms of {j - i} typed characters ("{"".join(text[i:j])}"), '
                                   f'typed {t0 + times[i]:.2f}-{t0 + times[j - 1]:.2f}s; the sound must follow every character', t0 + times[i], t0 + times[j - 1],
                                   {'chars': j - i}))
            i = j
        overrun = tail_end - times[-1]
        if overrun > c['max_overrun_s']:
            bad = True
            out.append(Finding(NAME, 'FAIL', f'{label}: sound runs {overrun * 1000:.0f} ms past the last typed character (limit {c["max_overrun_s"] * 1000:.0f} ms)', t0 + times[-1], t0 + tail_end))
        if not bad:
            out.append(Finding(NAME, 'INFO', f'{label}: {len(times)} characters typed {t0 + times[0]:.2f}-{t0 + times[-1]:.2f}s, {sum(matched)} with a key onset within {c["tolerance_s"] * 1000:.0f} ms'))
    return out
