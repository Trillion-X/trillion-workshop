"""placement: a graphic does not sit where the person on screen is showing something.
The action zone is measured from the footage itself: the mean absolute grey change between consecutive video frames at each cell of a heat_width x heat_height
grid. A graphic box of the timeline (not a full frame cover, under max_box_frac of the frame) fails when the footage under it moves at least action_heat on
average (hands and what they hold).
  - With base footage (the limits' placement.bases: {regex on the video's path: [{file, from, to}]}, each file the source footage without the overlay from
    `from` to `to` seconds of the source, named relative to the folder lane_root_regex matches in the video's path, else beside the video): the change is read
    from the base at the source seconds the video plays (prepend, cuts and holds undone), frame by frame while each box is visible and no full-frame cover
    (cover_key, with a known end) lies under it, so a graphic that covers nearly the whole frame hides nothing. A range no base holds is UNREACHED, never a pass.
  - Without: from the delivered video, only over the frames where the overlay does not cover that cell (so the graphic's own motion is never counted), and only
    where at least min_uncovered_frac of the video frames could be observed.
Side balance across a film made as several options per moment (only when the limits hold a variety section and placement.scope_regex matches the video): an
option's side is `left`, `right` or `centre` from the area-weighted centre of its timeline boxes (left_below, right_above); it fails when its side is the side
of more than max_side_share of all built options of the variety ledger (their timelines found by placement.timeline_glob), once min_options_for_side have one."""
import glob
import os
import re

import cv2
import numpy as np

from .. import jsonio, media
from ..report import Finding
from .reused_footage import cut_clips, project_path
from .variety import find_full_film, ledger_rows

NAME = 'placement'

OVERLAY_ONLY = True
EMPTY_SET = 'not applicable: every graphic'


def covers_only(ctx, c):
    """True when the spec has graphics and every one of them is a full-frame cover (covers_a_roll): the frame is covered, so no graphic sits over the footage."""
    graphics = [ev for ev in ctx.spec.get('events', []) if ev.get('type') not in c['non_graphic_types']]
    return bool(graphics) and all(ev.get(c['cover_key']) for ev in graphics)


def needs(ctx):
    c = ctx.cfg['placement']
    if ctx.overlay and ctx.timeline and ctx.timeline.get('boxes'):
        return None
    if ctx.overlay and covers_only(ctx, c):
        return 'not applicable: every graphic in this video is a full-frame cover (covers_a_roll), so none sits over the footage to be judged'
    return 'no overlay.mov or no element boxes in its timeline'


def side(timeline, c, frame_width):
    boxes = (timeline or {}).get('boxes', [])
    area = sum((b['box'][2] - b['box'][0]) * (b['box'][3] - b['box'][1]) for b in boxes)
    if not area:
        return None
    cx = sum((b['box'][0] + b['box'][2]) / 2 * (b['box'][2] - b['box'][0]) * (b['box'][3] - b['box'][1]) for b in boxes) / area
    frac = cx / frame_width
    return 'left' if frac < c['left_below'] else 'right' if frac > c['right_above'] else 'centre'


def side_balance(ctx, c):
    """The side finding of this option against every built option of the variety ledger; [] without a variety section or scope_regex, outside the scope, or while
    too few options have a timeline."""
    ledger = ctx.cfg.get('variety')
    if not ledger or not c.get('scope_regex') or not re.search(c['scope_regex'], ctx.preview):
        return []
    found = find_full_film(ctx.preview, ledger)
    if not found:
        return []
    base = os.path.dirname(os.path.dirname(found[0]))
    sides = {}
    for o, r in ledger_rows(found[0]).items():
        tls = sorted(glob.glob(os.path.join(base, c['timeline_glob'].format(lane=r['lane'], option=o))))
        if r['kind'] == 'built' and tls:
            sides[o] = side(jsonio.read(tls[-1]), c, ctx.cfg['frame']['width'])
    sides = {o: s for o, s in sides.items() if s}
    mine = side(ctx.timeline, c, ctx.cfg['frame']['width'])
    if not mine or len(sides) < c['min_options_for_side']:
        return []
    share = list(sides.values()).count(mine) / len(sides)
    if share <= c['max_side_share']:
        return []
    return [Finding(NAME, 'FAIL', f'this option\'s graphics sit on the {mine} of the frame, as do {share:.0%} of all {len(sides)} built options (limit {c["max_side_share"]:.0%}); place this one on another side where it does not cover what the person shows',
                    data={'side': mine, 'share': share})]


def base_footage(ctx, c):
    """[(file, from, to)] of the base footage for this video, from the limits' placement.bases (path regex -> spans {file relative to the lane folder, from, to} in
    seconds of the source; each file starts at its `from`), or None when the limits give no bases or none matches."""
    for pattern, spans in (c.get('bases') or {}).items():
        if re.search(pattern, ctx.preview):
            root_regex = c.get('lane_root_regex')
            lane = re.match(root_regex, ctx.preview) if root_regex else None      # files are named from the lane folder, wherever in it the video sits; elsewhere beside the video
            root = lane.group(0) if lane else os.path.dirname(ctx.preview)
            return [(os.path.normpath(os.path.join(root, s['file'])), float(s['from']), float(s['to'])) for s in spans]
    return None


def source_names(ctx, a, b):
    """', '-joined names of the camera files of the source cut that play between its seconds a and b (from the cut project of the reused_footage limits), or ''."""
    if not ctx.cfg.get('reused_footage'):
        return ''
    project = project_path(ctx)
    if not project:
        return ''
    names = sorted({n for n, s, e, _ in cut_clips(project, ctx.cfg['reused_footage']) if s < b and e > a})
    return ', '.join(names)


def base_diffs(ctx, c, base):
    """(D, None): D[k] is the grey change between video frames k and k+1 of the base footage at the source seconds the video plays (the stitched sequence mapped by
    ctx.source_time: prepend, cuts, hold), the overlay never in it; NaN where there is none (a held frame has no consecutive frame). Or (None, why) when that footage is
    not on disk or does not cover the whole range."""
    w, h = c['heat_width'], c['heat_height']
    fps = ctx.info['fps']
    n = int(round(ctx.info['duration'] * fps))
    src = [ctx.source_time(k / fps) for k in range(n)]
    runs, k = [], 0      # stretches of consecutive source frames: each is read from the one span that holds all of it
    while k < n:
        j = k
        while j + 1 < n and abs(src[j + 1] - src[j] - 1 / fps) < 0.5 / fps:
            j += 1
        if j > k:
            runs.append((k, j))
        k = j + 1
    slack = c['base_slack_s']
    plan, lost = [], []
    for run_k, j in runs:
        k = run_k
        while k <= j:      # a run that crosses from one span into the next is read piece by piece (the one change between the two frames at the seam is not read)
            lo = src[k]
            span = next((s for s in base if s[1] - slack <= lo < s[2] + slack), None)
            end = j if span is None else min(j, k + max(int((span[2] + slack - lo) * fps) - 1, 0))
            hi = src[end] + 1 / fps
            if span is None:
                lost.append(f'the source {lo:.1f}-{hi:.1f}s ({source_names(ctx, lo, hi) or "source unknown"}) is in none of the base spans ({", ".join(f"{a:.0f}-{b:.0f}s" for _, a, b in base)})')
            elif not os.path.isfile(span[0]):
                lost.append(f'the source {lo:.1f}-{hi:.1f}s ({source_names(ctx, lo, hi) or "source unknown"}): the base footage {os.path.basename(span[0])} is not on disk')
            else:
                plan.append((span, k, end))
            k = end + 1
    if lost:
        return None, '; '.join(dict.fromkeys(lost))
    diffs = np.full((n, h, w), np.nan, np.float32)
    for (path, t_base, _), k, j in plan:
        g = media.frames(path, w, h, 'gray', ss=src[k] - t_base, t=(j - k + 1) / fps).astype(np.float32)
        d = np.abs(np.diff(g, axis=0))
        diffs[k:k + len(d)] = d
    return diffs, None


def cover_spans(ctx, c):
    """[(id or type, start, end)] in overlay seconds of every opaque full-frame cover of the spec (covers_a_roll) whose start and end are both known: its `until` / `out`.
    A cover with no known end is left out, so a box is never excused by a cover that may not be there."""
    out = []
    for ev in ctx.spec.get('events', []):
        start, end = ctx.element_start(ev), ev.get('until', ev.get('out'))
        if ev.get(c['cover_key']) and start is not None and isinstance(end, (int, float)):
            out.append((str(ev.get('id') or ev.get('type')), float(start), float(end)))
    return out


def base_boxes(ctx, c, diffs):
    """{box id: result} for every graphic box. The motion under a box is the mean of the base footage's change over the frames where the box is visible (its latest
    timeline box at that moment, and the overlay has pixels there) and no opaque full-frame cover lies beneath it (cover_spans); a held frame has no change to read.
    A result is {'heat', 'frames', 'from', 'to'} (video-frame count, overlay seconds), or {'heat': None, 'why', 'from', 'to'} when no frame qualified."""
    w, h = c['heat_width'], c['heat_height']
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    fps, t0 = ctx.info['fps'], ctx.overlay_t0 or 0.0
    alpha, ofps = ctx.overlay_alpha(), ctx.overlay_fps()
    ah, aw = alpha.shape[1:]
    covers = cover_spans(ctx, c)
    ids = {}
    for b in ctx.timeline['boxes']:
        ids.setdefault(b['id'], []).append(b)
    out = {}
    for bid, entries in ids.items():
        entries.sort(key=lambda b: b['t0'])
        total, frames, seen, used, lost_cover, lost_hold = 0.0, 0, [], [], 0, 0
        exit_sum, exit_used = 0.0, []      # the exit window: frames after the last cover has ended, when what was on it rides away over live footage; exits are not exempt
        for k in range(len(diffs)):
            to = k / fps - t0
            j = int(to * ofps)
            now = [b for b in entries if b['t0'] <= to]
            if not now or not 0 <= j < len(alpha):
                continue
            x0, y0, x1, y1 = now[-1]['box']
            ix0, iy0, ix1, iy1 = max(int(x0 * aw / fw), 0), max(int(y0 * ah / fh), 0), min(int(np.ceil(x1 * aw / fw)), aw), min(int(np.ceil(y1 * ah / fh)), ah)
            if ix1 <= ix0 or iy1 <= iy0 or (alpha[j, iy0:iy1, ix0:ix1] > c['covered_alpha']).mean() < c['visible_frac']:
                continue
            seen.append(to)
            if any(a <= to < b for _, a, b in covers):
                lost_cover += 1
                continue
            if np.isnan(diffs[k, 0, 0]):
                lost_hold += 1
                continue
            sx, sy = w / fw, h / fh
            region = diffs[k, max(int(y0 * sy), 0):min(int(np.ceil(y1 * sy)), h), max(int(x0 * sx), 0):min(int(np.ceil(x1 * sx)), w)]
            if region.size:
                total += float(region.mean())
                frames += 1
                used.append(to)
                if covers and to >= max(b for _, _, b in covers):
                    exit_sum += float(region.mean())
                    exit_used.append(to)
        shown = used or seen      # the frames that were measured, else where the box was visible
        span = {'from': min(shown) if shown else entries[0]['t0'], 'to': max(shown) if shown else entries[0]['t0']}
        if frames:
            out[bid] = {'heat': total / frames, 'frames': frames, **span}
            if exit_used:      # followed per frame only when the timeline records the box after the cover ends; otherwise it is read at its last recorded place
                out[bid]['exit'] = {'heat': exit_sum / len(exit_used), 'frames': len(exit_used), 'from': min(exit_used), 'to': max(exit_used),
                                    'followed': any(b['t0'] >= max(e for _, _, e in covers) for b in entries)}
        else:
            why = ('under the full-frame cover ' + ', '.join(f'"{i}" (overlay {a:.1f}-{b:.1f}s)' for i, a, b in covers if a <= span['to'] and b > span['from'])) if lost_cover else 'over a held frame, where nothing moves' if lost_hold else 'never visible over footage'
            out[bid] = {'heat': None, 'why': why, 'frames': 0, **span}
    return out


def exit_note(r, t0, c):
    """', of which the exit window (after the cover ends) ...' for a box measured during its exit, or ''. The exit is part of the mean above, never exempted; its own mean is shown
    so the maker can see whether the exit is what fails."""
    e = r.get('exit')
    if not e:
        return ''
    where = 'position followed per frame from the timeline' if e['followed'] else 'read at its last recorded place: the timeline holds no box for it after the cover ends'
    return f'; exit window {t0 + e["from"]:.1f}-{t0 + e["to"]:.1f}s {e["heat"]:.1f} over {e["frames"]} frames, {where}'


def base_run(ctx, c, base):
    """The placement findings from the base footage, time by time (see base_boxes)."""
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    t0 = ctx.overlay_t0 or 0.0
    diffs, why = base_diffs(ctx, c, base)
    if why:
        return side_balance(ctx, c) + [Finding(NAME, 'WARN', f'UNREACHED: {why}, so the placement of the graphics is not measured', data={'not_measured': True, 'unreached': True})]
    cover_ids = {str(ev.get('id')) for ev in ctx.spec.get('events', []) if ev.get(c['cover_key'])}
    big = {b['id'] for b in ctx.timeline['boxes'] if (b['box'][2] - b['box'][0]) * (b['box'][3] - b['box'][1]) > c['max_box_frac'] * fw * fh or b['id'].split('-')[0] in cover_ids}
    results = {i: r for i, r in base_boxes(ctx, c, diffs).items() if i not in big}
    out = side_balance(ctx, c)
    for i, r in results.items():
        if r['heat'] is not None and r['heat'] >= c['action_heat']:
            out.append(Finding(NAME, 'FAIL', f'graphic "{i}" sits over footage that moves {r["heat"]:.1f} (limit {c["action_heat"]}) over {r["frames"]} frames ({t0 + r["from"]:.1f}-{t0 + r["to"]:.1f}s){exit_note(r, t0, c)}: '
                               'that is where the person is showing or doing something; move it to the side of the frame where nothing moves', t0 + r['from'], data={'id': i, 'heat': r['heat'], 'frames': r['frames']}))
    if out:
        return out
    data = {'boxes': results, 'peak_heat': max([r['heat'] for r in results.values() if r['heat'] is not None], default=0.0)}
    measured = [i for i, r in results.items() if r['heat'] is not None]
    on_cover = [f'"{i}" (video {t0 + r["from"]:.1f}-{t0 + r["to"]:.1f}s, {r["why"]})' for i, r in results.items() if r['heat'] is None]
    if not measured:
        return [Finding(NAME, 'INFO', f'{EMPTY_SET} ({len(results) + len(big)} box(es)) is never over visible footage, so none hides what the person is showing: ' + '; '.join(on_cover), data={**data, 'empty_set': True})]
    exits = [f'"{i}" {r["exit"]["heat"]:.2f} over {r["exit"]["frames"]} frames' for i, r in results.items() if r.get('exit')]
    unfollowed = any(not r['exit']['followed'] for r in results.values() if r.get('exit'))
    tail = f'; exit windows (after the cover ends): {"; ".join(exits)}' + ('; read at each box\'s last recorded place, the timeline holds no box for it after the cover ends' if unfollowed else '') if exits else ''
    tail += f'; not over visible footage, so not judged: {"; ".join(on_cover)}' if on_cover else ''
    return [Finding(NAME, 'INFO', f'{len(measured)} graphic boxes measured while over visible footage; none sits over moving hands or held objects (highest mean change under a box {data["peak_heat"]:.2f}, limit {c["action_heat"]}){tail}', data=data)]


def composite_heat(ctx, c):
    """(heat grid, observed fraction grid) from the delivered video, only where the overlay does not cover (no base footage given)."""
    w, h = c['heat_width'], c['heat_height']
    g = media.frames(ctx.preview, w, h, 'gray').astype(np.float32)
    fps = ctx.info['fps']
    a = ctx.overlay_alpha()
    ofps = ctx.overlay_fps()
    t0 = ctx.overlay_t0 or 0.0
    d = np.abs(np.diff(g, axis=0))
    heat, seen = np.zeros((h, w)), np.zeros((h, w))
    for k in range(len(d)):
        j = int((k / fps - t0) * ofps)
        free = ~(cv2.resize(a[j], (w, h)) > c['covered_alpha']) if 0 <= j < len(a) else np.ones((h, w), bool)
        heat[free] += d[k][free]
        seen[free] += 1
    return heat / np.maximum(seen, 1), seen / max(len(d), 1)


def run(ctx):
    c = ctx.cfg['placement']
    w, h = c['heat_width'], c['heat_height']
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    t0 = ctx.overlay_t0 or 0.0
    base = base_footage(ctx, c)
    if base:      # the motion under a graphic is a property of the footage: read it from the base, so a graphic that covers the frame hides nothing
        return base_run(ctx, c, base)
    heat, frac = composite_heat(ctx, c)
    cover_ids = {str(ev.get('id')) for ev in ctx.spec.get('events', []) if ev.get(c['cover_key'])}
    out, judged, covers, unseen, peak = side_balance(ctx, c), 0, 0, [], 0.0
    for b in ctx.timeline['boxes']:
        x0, y0, x1, y1 = b['box']
        if (x1 - x0) * (y1 - y0) > c['max_box_frac'] * fw * fh or b['id'].split('-')[0] in cover_ids:
            covers += 1
            continue
        sx, sy = w / fw, h / fh
        ix0, iy0, ix1, iy1 = max(int(x0 * sx), 0), max(int(y0 * sy), 0), min(int(np.ceil(x1 * sx)), w), min(int(np.ceil(y1 * sy)), h)
        if ix1 <= ix0 or iy1 <= iy0 or frac[iy0:iy1, ix0:ix1].mean() < c['min_uncovered_frac']:
            unseen.append(b['id'])
            continue
        judged += 1
        m = float(heat[iy0:iy1, ix0:ix1].mean())
        peak = max(peak, m)
        if m >= c['action_heat']:
            out.append(Finding(NAME, 'FAIL', f'graphic "{b["id"]}" sits over footage that moves {m:.1f} (limit {c["action_heat"]}): that is where the person is showing or doing something; move it to the side of the frame where nothing moves',
                               t0 + b['t0'], data={'id': b['id'], 'heat': m}))
    if out:
        return out
    if unseen:
        return [Finding(NAME, 'WARN', f'{judged} graphic boxes measured; {len(unseen)} ({", ".join(sorted(set(unseen)))}) could not be observed (the overlay covers that part of the frame for nearly all of the video), so their placement is not measured',
                        data={'not_measured': True})]
    if not judged:
        return [Finding(NAME, 'INFO', f'{EMPTY_SET} ({covers} box(es)) is a full-frame cover, so none sits over the footage to be judged', data={'empty_set': True})]
    return [Finding(NAME, 'INFO', f'{judged} graphic boxes measured; none sits over moving hands or held objects (highest mean change under a box {peak:.2f}, limit {c["action_heat"]})', data={'peak_heat': peak})]
