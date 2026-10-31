"""One plan into one cut: the timeline, the pictures, the one soundtrack, the overlay, the checks and the move.

A plan is {slug, format: {option, medium, aspects_also?}, sources?: {clip: media file}, segments: [{kind, clip, from, to, text, ...}]}.
The request's piece table says what each segment kind becomes (read-data/plan_pieces.py). The cut is one edit of the Workshop tool
media-composition (its EDL), rendered by its render-an-edit: each segment one clip of that edit at the plan's own aspect and the
rules' frame rate, frame-exact (clip frames), and every sound one placement on the edit's timeline at the exact start of its
picture, so nothing drifts. This file lays the edit out; it builds no filter graph of its own.

  clip         the source from-to. Its sound is the source's own when its grade row says as-is (or when the request gives no
               grades), else the row's graded file; a span with no row, or a graded file that is missing, stops the cut by name.
               Each edge takes only the handle the neighbouring word leaves free; two clips that follow each other cross-fade in the
               quiet between their words and the picture cuts halfway. A source with no picture plays over a borrowed open-eyed
               still that pushes in, with its words as captions.
  voiced_line  the take of the segment's text from the voice folder over a held frame of the next clip (the previous clip's last
               frame when no clip follows), the rules' room after the line.
  slide        one still per segment, drawn by the renderer at the plan's aspect, and all of them as one PDF.
  skip         not cut.

The cut is made in its work folder and moved to the folder the person sees only when ffprobe finds it whole and every check row
of the request passes (never show an unfinished cut).
"""
import json
import shutil
import subprocess
from pathlib import Path

from PIL import Image

import faces
import graphics
import media
from fill import Refused, fill, merged
from plan_pieces import aspects_of, is_slides, pieces_of, span_key
from timing import room

HERE = Path(__file__).resolve().parent
DEFAULT_RULES = HERE.parent / 'read-data' / 'cut-rules.json'


def rules_of(req, frame=None):
    rules = merged(json.loads(DEFAULT_RULES.read_text()), req.get('rules', {}))
    if frame:
        rules = merged(rules, {'frame': {'width': frame[0], 'height': frame[1]}})
    return rules


def voice_takes(folder):
    """{text: take file} of a voice folder: each take <name>.wav beside <name>.txt holding its exact text"""
    out = {}
    for txt in sorted(Path(folder).glob('*.txt')):
        wav = txt.with_suffix('.wav')
        if wav.is_file():
            out.setdefault(txt.read_text(), wav)
    return out


def take_words(take, timer):
    """the take's word times, cached beside it as <name>.words.json ({"words": [...]}), made by the request's word timer"""
    out = take.with_suffix('.words.json')
    if not out.exists():
        if not timer:
            raise Refused(f'{out} is missing and the request names no voice.word_timer to make it')
        argv = [str(a) for a in fill(timer['argv'], {'media': str(take), 'out': str(out)})]
        r = subprocess.run(argv, capture_output=True, text=True)
        if r.returncode or not out.exists():
            raise Refused(f'the word timer did not write {out}: {r.stderr.strip()[-400:]}')
    return json.loads(out.read_text())['words']


class Plan:
    """a plan with what the request knows about it: its pieces, its sources and their words, its looks, its grades"""

    def __init__(self, req, plan_file):
        self.req, self.file = req, Path(plan_file)
        self.plan = json.loads(self.file.read_text())
        self.slug = self.plan['slug']
        self.rows = pieces_of(self.plan, req['pieces'])
        self.folder = self.file.with_suffix('')
        self._words = {}

    def words_file(self, clip):
        folder = (self.req.get('clips') or {}).get('words_folder')
        if not folder:
            raise Refused(f'{self.slug} cuts clip {clip}: the request needs clips.words_folder, the folder of <clip>.words.json')
        return Path(folder) / f'{clip}.words.json'

    def source(self, clip):
        found = (self.plan.get('sources') or {}).get(clip)
        return found or json.loads(self.words_file(clip).read_text())['source']

    def clip_words(self, clip):
        if clip not in self._words:
            self._words[clip] = json.loads(self.words_file(clip).read_text())['words']
        return self._words[clip]

    def look(self, clip):
        looks = self.req.get('looks') or {}
        name = (looks.get('by_clip') or {}).get(clip, looks.get('default'))
        if name is None:
            return ''
        if name not in looks.get('chains', {}):
            raise Refused(f'clip {clip} takes look {name}, which looks.chains does not hold')
        return media.filter_chain(looks['chains'][name])

    def grades(self):
        g = self.req.get('grades')
        if not g:
            return None
        path = self.folder / g.get('file', 'grades.json')
        return json.loads(path.read_text())['spans'] if path.is_file() else {}

    def span_audio(self, s, grades, source):
        """(file, its first source second) the span's sound is read from: the source for an as-is grade, else the row's graded file
        from the row's audio_from. A span with no row, or a graded span whose file is missing, stops the cut."""
        if grades is None:
            return source, 0.0
        g, rule = grades.get(span_key(s)), self.req['grades']
        sid = span_key(s)
        if g is None:
            raise Refused(f'span {sid} has no row in {self.folder / rule.get("file", "grades.json")}: grade it before the cut')
        if g.get('treatment') == rule.get('as_is', 'as-is'):
            return source, 0.0
        written = g.get('audio')
        if not written or not (self.folder / written).is_file():
            raise Refused(f"span {sid} is graded {g.get('grade')} ({g.get('treatment')}) but its graded file "
                          f"{self.folder / (written or '<none named>')} is missing; the source's own sound is only for as-is spans")
        return str(self.folder / written), g['audio_from']

    def recreated(self, s, grades):
        key = (self.req.get('grades') or {}).get('recreated_key', 'cloned')
        return bool((grades or {}).get(span_key(s), {}).get(key) or s.get(key))


def frame_of(p):
    aspects = aspects_of(p.plan, p.req['pieces'])
    if len(aspects) != 1:
        raise Refused(f"{p.slug}: a cut is made at one aspect; the plan names {', '.join(a[0] for a in aspects) or 'none'}. "
                      'Ask once per aspect with format.aspects_also narrowed.')
    return aspects


def lay_out(p, rules):
    """the timing of the cut before any picture is made: its segments, pieces, sources, edges, crossfades and timeline"""
    segs = [s for s in p.plan['segments'] if p.rows[s['kind']]['piece'] != 'skip']
    piece = [p.rows[s['kind']]['piece'] for s in segs]
    is_clip = [x == 'clip' for x in piece]
    srcs = {c: p.source(c) for c in {x['clip'] for i, x in enumerate(segs) if is_clip[i]}}
    sound_only = {c for c, f in srcs.items() if not media.has_picture(f)}
    fr, e = media.frame_s(rules), rules['edges']
    xf_s = e['crossfade_frames'] * fr
    free = {i: (room(p.clip_words(x['clip']), x['from'], -1, e), room(p.clip_words(x['clip']), x['to'], 1, e))
            for i, x in enumerate(segs) if is_clip[i]}
    xf = {i: max(e['crossfade_min_s'], min(xf_s, free[i][1], free[i + 1][0])) for i in range(len(segs) - 1) if is_clip[i] and is_clip[i + 1]}
    edge = {}
    for i in free:
        ah = xf[i - 1] if i - 1 in xf else free[i][0]
        at = xf[i] if i in xf else free[i][1]
        vh = xf[i - 1] / 2 if i - 1 in xf else free[i][0]
        if i > 0 and piece[i - 1] == 'voiced_line':
            vh = max(vh, e['speech_lead_s'])
        edge[i] = (ah, at, vh, xf[i] / 2 if i in xf else free[i][1])
    takes = voice_takes(p.req['voice']['folder']) if 'voiced_line' in piece else {}
    timeline, t, frames = [], 0.0, {}
    for i, s in enumerate(segs):
        if piece[i] == 'clip':
            ah, at, vh, vt = edge[i]
            n = max(1, media.frames(s['to'] - s['from'] + vh + vt, rules))
        elif piece[i] == 'voiced_line':
            if s['text'] not in takes:
                raise Refused(f"{p.slug}: segment {i} has no take of its line in {p.req['voice']['folder']}: run the voice-lines step first "
                              f"({s['text'][:80]!r})")
            n = media.frames(media.probe_dur(takes[s['text']]) + rules['voiced_line']['room_after_s'], rules)
        else:
            raise Refused(f"{p.slug}: segment kind {s['kind']} names piece {piece[i]}, which a film cut cannot hold")
        frames[i] = n
        timeline.append({'seg': i, 'kind': s['kind'], 'text': s['text'], 'start': round(t, 4), 'dur': round(n * fr, 4)})
        t += n * fr
    return {'segs': segs, 'piece': piece, 'is_clip': is_clip, 'srcs': srcs, 'sound_only': sound_only, 'xf': xf, 'edge': edge,
            'takes': takes, 'frames': frames, 'timeline': timeline, 'seconds': t}


def timeline(req, plan_file):
    """the cut's timeline and length, without making anything"""
    p = Plan(req, plan_file)
    if is_slides(p.plan, p.rows):
        raise Refused(f'{p.slug} is slides: it has no timeline')
    aspects = frame_of(p)
    rules = rules_of(req, aspects[0][1:])
    lay = lay_out(p, rules)
    out = {'slug': p.slug, 'seconds': round(lay['seconds'], 4), 'timeline': lay['timeline'], 'crossfades': [round(v, 3) for v in lay['xf'].values()]}
    if req.get('compare_with'):
        out['compared'] = compare_timelines(json.loads(Path(req['compare_with']).read_text()), lay['timeline'])
    return out


def compare_timelines(before, now):
    """every field of every segment that differs between a timeline made before (a timeline.json) and this one"""
    keys = ('seg', 'kind', 'text', 'start', 'dur')
    differ = [{'seg': b.get('seg'), 'field': k, 'before': b.get(k), 'now': n.get(k)} for b, n in zip(before, now) for k in keys if b.get(k) != n.get(k)]
    if len(before) != len(now):
        differ.append({'seg': None, 'field': 'segments', 'before': len(before), 'now': len(now)})

    def end(t):
        return round(t[-1]['start'] + t[-1]['dur'], 4) if t else 0.0
    return {'same': not differ, 'differences': differ, 'segments': [len(before), len(now)], 'seconds': [end(before), end(now)]}


def folders_of(req, p):
    f = req.get('folders') or {}
    for k in ('work', 'seen'):
        if not f.get(k):
            raise Refused(f'the request needs folders.{k}: the work folder root and the folder the person sees')
    name = req.get('cut_name') or p.slug
    return Path(f['work']) / name, Path(f['seen'])


def ref(path, base):
    """path as the spec names it: relative to base when the request gives one (refs.*_relative_to), else as it is"""
    if not base:
        return str(path)
    try:
        return str(Path(path).resolve().relative_to(Path(base).resolve()))
    except ValueError as e:
        raise Refused(f'{path} is not inside {base}: move the folder or change refs so the spec can name it from there') from e


def run_checks(rows, values, work):
    """every check row run on the made cut (all of them, so every report is complete): passed when its exit code is in
    pass_exit_codes (default [0]) and no line of its output holds fail_line_contains; advisory when its exit code is in
    advisory_exit_codes"""
    out = []
    for row in rows:
        report = work / f"{row['id']}.json"
        argv = [str(a) for a in fill(row['argv'], {**values, 'report': str(report)})]
        r = subprocess.run(argv, cwd=row.get('cwd'), capture_output=True, text=True)
        (work / f"{row['id']}.txt").write_text(r.stdout + r.stderr)
        mark = row.get('fail_line_contains')
        failed = [line for line in r.stdout.splitlines() if mark and mark in line]
        out.append({'id': row['id'], 'exit': r.returncode, 'passed': r.returncode in row.get('pass_exit_codes', [0]) and not failed,
                    'advisory': r.returncode in row.get('advisory_exit_codes', []), 'fail_lines': failed,
                    'report': str(report) if report.exists() else None, 'output_tail': (r.stdout + r.stderr).strip()[-600:]})
    return out


FIT = {'fill_mode': 'black'}
SHOTS = 'cut'


def seg_id(i):
    return f'{i:02d}'


def shot_of(spans, clip, t):
    """the recorded span whose shot match a held frame of clip at source second t takes: the span of that clip holding t, else
    the nearest one (None when the clip has no recorded span in the cut)"""
    near = [(0 if a <= t <= b else min(abs(t - a), abs(t - b)), a, i) for i, (c, a, b) in spans.items() if c == clip]
    return min(near)[2] if near else None


def held(p, i, clip, src, t, n, spans):
    """the edit clip of a frame of clip held for n frames: fitted to the frame, in the clip's look, matched like its shot"""
    seg = {'id': seg_id(i), 'kind': 'clip', 'source': src, 'still': {'at': round(t, 3)}, 'frames': n, 'reframe': FIT}
    if p.look(clip):
        seg['grade'] = p.look(clip)
    shot = shot_of(spans, clip, t)
    if shot is not None:
        seg['shot_match'] = {'like': seg_id(shot)}
    return seg


def pictures(p, lay, reader, work, rules):
    """the picture of the cut as media-composition edit clips, one per segment, and what is decided with them: the transition into
    each next segment, the held frames, and the segments whose still is read for their graphics.

    A recorded span is its source from-to, fitted to the frame in its clip's look, its shot matched to the cut's other spans. A
    sound-only span holds an open-eyed frame borrowed from the ends of the plan's video spans (dealt out in turn) and pushes in. A
    voiced line holds an open-eyed frame of the next span (the previous span's last frame when no span follows); a held frame from
    another moment than the next span's first frame dissolves into it."""
    segs, piece, is_clip, srcs, sound_only, edge = (lay[k] for k in ('segs', 'piece', 'is_clip', 'srcs', 'sound_only', 'edge'))
    fr = media.frame_s(rules)
    spans = {i: (x['clip'], x['from'] - edge[i][2], x['to'] + edge[i][3]) for i, x in enumerate(segs) if is_clip[i] and x['clip'] not in sound_only}
    pool = []
    for j, (clip, a, b) in spans.items():
        for tg, tc in (('a', a), ('b', b)):
            t, _, _, ok, _ = faces.best_frame(reader, srcs[clip], tc, work, f'pool{j:02d}{tg}', rules, match=False)
            if ok:
                pool.append((clip, t))
    stand = {}
    for j, x in enumerate(segs):
        if is_clip[j] and x['clip'] in sound_only:
            if not pool:
                raise Refused(f'{p.slug}: a sound-only clip and no video clip in the plan to borrow a still from')
            stand[j] = pool[len(stand) % len(pool)]
    clips, transitions, holds, stills = [], [None] * len(segs), [], {}
    dissolve = rules['hold']['dissolve_frames']
    for i, s in enumerate(segs):
        n = lay['frames'][i]
        if piece[i] == 'clip' and i in spans:
            a = max(0.0, s['from'] - edge[i][2])
            seg = {'id': seg_id(i), 'kind': 'clip', 'source': srcs[s['clip']], 'in': round(a, 3), 'out': round(a + n * fr, 4), 'frames': n,
                   'muted': True, 'reframe': FIT, 'shot_match': {'group': SHOTS}}
            if p.look(s['clip']):
                seg['grade'] = p.look(s['clip'])
            clips.append(seg)
            continue
        if piece[i] == 'clip':
            clip, t = stand[i]
            seg = held(p, i, clip, srcs[clip], t, n, spans)
            seg['ken_burns'] = {'zoom_from': 1, 'zoom_to': 1 + p.req['devices']['stand_in']['push']}
            clips.append(seg)
            stills[i] = work / f'{seg_id(i)}.png'
            continue
        j = next((k for k in range(i + 1, len(segs)) if is_clip[k]), None)
        joins = False
        if j is not None and j == i + 1:
            if j in stand:
                (clip, t), eyes, mouth, ok = stand[j], -1.0, -1.0, True
            else:
                clip, tc = segs[j]['clip'], spans[j][1]
                t, eyes, mouth, ok, _ = faces.best_frame(reader, srcs[clip], tc, work, f'q{i:02d}', rules)
                joins = abs(t - tc) > fr / 2
        else:
            prev = max(k for k in range(i) if is_clip[k])
            clip = segs[prev]['clip']
            if prev in stand:
                (clip, t), eyes, mouth, ok = pool[0], -1.0, -1.0, True
            else:
                t, eyes, mouth, ok, _ = faces.best_frame(reader, srcs[clip], spans[prev][2] - 0.05, work, f'q{i:02d}', rules)
        holds.append({'seg': i, 'line': s['text'], 'clip': clip, 't': round(t, 3), 'eyes': eyes, 'mouth': mouth, 'open_eyed': ok})
        # a dissolve overlaps the next span's first frames: the held frame runs that much longer under it, so the timeline keeps
        clips.append(held(p, i, clip, srcs[clip], t, n + (dissolve if joins else 0), spans))
        if joins:
            transitions[i] = {'renderer': 'xfade', 'type': 'fade', 'duration': round(dissolve * fr, 4)}
        stills[i] = work / f'{seg_id(i)}.png'
    return clips, transitions, holds, stills


def encode_of(rules, **over):
    e = rules['encode']
    return {'width': rules['frame']['width'], 'height': rules['frame']['height'], 'fps': media.fps_text(rules), 'crf': e['crf'],
            'preset': e['preset'], 'audio_bitrate': e['audio_bitrate'], **over}


def read_stills(clips, stills, work, rules):
    """each still a segment's graphics are laid over, as it is rendered (its look and shot match): one frame of each of those
    segments rendered as one edit, then each frame read out as the segment's PNG"""
    if not stills:
        return
    at = {c['id']: c for c in clips}
    one = [{k: v for k, v in at[seg_id(i)].items() if k != 'ken_burns'} | {'frames': 1} for i in sorted(stills)]
    folder = work / 'stills'
    media.render({'encode': encode_of(rules, crf=0, preset='ultrafast'), 'spine': {'segments': one}}, folder / 'stills.mp4', folder / 'pieces')
    media.run(['-i', str(folder / 'stills.mp4'), str(folder / 'f%03d.png')])
    for k, i in enumerate(sorted(stills), 1):
        shutil.move(str(folder / f'f{k:03d}.png'), str(stills[i]))
    shutil.rmtree(folder)


def build(req, plan_file, make=True):
    """the cut of one plan (make False: its edit, its timeline and its overlay spec only; nothing rendered for the person, checked
    or moved). The cut is one media-composition edit (work/edit.json): every segment a clip of it, every sound a placement on its
    timeline, the overlay a layer over it, rendered by render-an-edit."""
    p = Plan(req, plan_file)
    if is_slides(p.plan, p.rows):
        if not make:
            raise Refused(f'{p.slug} is slides: there is no cut to lay out; run build')
        return slides(req, p)
    aspects = frame_of(p)
    rules = rules_of(req, aspects[0][1:])
    devices = req['devices']
    renderer = graphics.Renderer(req.get('overlay_renderer'), rules)
    lay = lay_out(p, rules)
    segs, piece, is_clip, srcs, sound_only, xf, edge = (lay[k] for k in ('segs', 'piece', 'is_clip', 'srcs', 'sound_only', 'xf', 'edge'))
    reader = faces.FaceReader(req.get('face_reader')) if any(is_clip) else None
    g = graphics.Graphics(devices, renderer, reader, rules)
    style = req.get('style') or devices['voiced_line']['default_style']
    work, seen = folders_of(req, p)
    for old in (work / 'gfx', work / 'edit', work / 'stills'):
        if old.exists():
            shutil.rmtree(old)
    work.mkdir(parents=True, exist_ok=True)
    final = seen / (req.get('cut_file') or f'{p.slug}.mp4')
    grades = p.grades()
    fr, au = media.frame_s(rules), rules['audio']
    # where each clip's sound is read from, settled before any picture is laid out
    heard_from = {i: p.span_audio(x, grades, srcs[x['clip']]) for i, x in enumerate(segs) if is_clip[i]}
    chain = {c: media.fitted(p.look(c), rules) for c in srcs}
    clips, transitions, holds, stills = pictures(p, lay, reader, work, rules)
    clips = media.match_shots({'encode': encode_of(rules), 'spine': {'segments': clips}}, work / 'grade', rules)['spine']['segments']
    read_stills(clips, stills, work, rules)
    level = {'lufs': au['piece_lufs'], 'gain_db': au['piece_gain_db']}
    placed, specs, said, asked = [], [], [], []
    t_start = 0.0
    for i, s in enumerate(segs):
        dur = lay['frames'][i] * fr
        sid = renderer.ident(f'{"q" if piece[i] == "voiced_line" else "s"}{i:02d}', style)
        if piece[i] == 'clip':
            ah, at, vh, vt = edge[i]
            a = max(0.0, s['from'] - vh)
            src = srcs[s['clip']]
            recreated = p.recreated(s, grades)
            left, top = True, devices['tag']['y']
            if s['clip'] in sound_only:
                left = faces.away_left(reader, stills[i], rules)
            elif s.get('label') or recreated:
                left, top = g.place_recorded(src, chain[s['clip']], a, dur, s.get('label'), recreated, work, f'{i:02d}')
            ev, ov = g.recorded_events(s.get('label'), recreated, dur, left, top)
            gev, gov = g.plan_graphics(s, a, src, chain[s['clip']], s['clip'] in sound_only, work, f'{i:02d}')
            ev, ov = ev + gev, max(ov, gov)
            words = [w for w in p.clip_words(s['clip']) if w['start'] >= s['from'] - 0.02 and w['end'] <= s['to'] + 0.02]
            if s['clip'] in sound_only:
                cev, cov = g.captions(words, a, dur, stills[i])
                ev, ov = cev + ev, max(ov, cov)
            if ev:
                specs.append((t_start, sid, ev, graphics.recorded_spec(g, sid, ov, ev, bool(gev))))
            # the span's sound from its edge handles, brought to the piece level and limited, faded over its crossfades (the rules'
            # edge fades where it has none), placed so its words land on its picture
            heard, first = heard_from[i]
            sound_in = max(0.0, s['from'] - ah - first)
            placed.append({'artifact': str(heard), 'start': round(t_start - (ah - vh), 4), 'in': round(sound_in, 3),
                           'out': round(sound_in + s['to'] - s['from'] + ah + at, 3), 'fade_in': xf.get(i - 1) or au['edge_fade_s']['head'],
                           'fade_out': xf.get(i) or au['edge_fade_s']['tail'], 'level': level, 'audio_filters': f"alimiter=limit={au['limit']}"})
            said += [{'text': w['text'], 'start': round(t_start + w['start'] - a, 3), 'end': round(t_start + w['end'] - a, 3)} for w in words]
        else:
            take = lay['takes'][s['text']]
            heard = take_words(take, p.req['voice'].get('word_timer'))
            line = [{'text': w['text'], 'start': round(t_start + w['start'], 3), 'end': round(t_start + w['end'], 3)} for w in heard]
            said += line
            asked += line
            ev, ov = g.voiced_line(style, s['text'], dur, heard, stills[i], p.rows[s['kind']]['tag'])
            specs.append((t_start, sid, ev, graphics.voiced_spec(g, sid, ov, ev, dur)))
            placed.append({'artifact': str(take), 'start': round(t_start, 4)})
        t_start += dur
    (work / 'timeline.json').write_text(json.dumps(lay['timeline'], indent=1))
    oid = renderer.ident('cut', style)
    spec = cut_spec(req, p, final, t_start, specs, said, asked, work, renderer, oid, aspects)
    outs = renderer.row['outputs']
    overlay = renderer.render_out(work / 'gfx', oid) / outs['overlay']
    sound = renderer.render_out(work / 'gfx', oid) / outs['sound'] if outs.get('sound') else None
    ln = au['loudnorm']
    edit = {'encode': encode_of(rules), 'spine': {'segments': clips, **({'transitions': transitions} if any(transitions) else {})},
            'audio_graph': {'narration': placed + ([{'artifact': str(sound), 'start': 0}] if sound else [])},
            'video_overlays': [{'source_path': str(overlay), 'start': 0}],
            'master_loudnorm': ln['I'], 'master_true_peak_dbfs': ln['TP'], 'master_loudness_range': ln['LRA'], 'master_loudnorm_linear': True}
    result = {'slug': p.slug, 'seconds': round(t_start, 4), 'timeline': str(work / 'timeline.json'), 'spec': spec['file'],
              'edit': str(work / 'edit.json'), 'holds': holds, 'crossfades': [round(v, 3) for v in xf.values()], 'graphics': len(specs)}
    if not make:
        (work / 'edit.json').write_text(json.dumps(edit, indent=1))
        return result
    od = renderer.render(work / 'gfx', spec['for_render'], oid)
    if sound and not sound.is_file():
        edit['audio_graph']['narration'] = placed
    (work / 'edit.json').write_text(json.dumps(edit, indent=1))
    unfinished = work / final.name
    media.render(edit, unfinished, work / 'edit')
    shutil.rmtree(work / 'eyes', ignore_errors=True)
    shutil.rmtree(work / 'edit', ignore_errors=True)
    Path(f'{unfinished}.result.json').unlink(missing_ok=True)
    if not media.complete(unfinished, t_start, rules):
        raise Refused(f'{p.slug}: {unfinished} is not a whole cut (one video and one audio stream, {t_start:.2f} s); not moved to {final}')
    values = {'cut': str(unfinished), 'spec': spec['file'], 'overlay': str(overlay), 'timeline': str(od / outs['timeline']),
              'work': str(work), 'plan_file': str(p.file), 'cut_timeline': str(work / 'timeline.json')}
    checks = run_checks(req.get('checks', []), values, work)
    result['checks'] = checks
    failed = [c for c in checks if not c['passed']]
    if failed:
        raise Refused(f'{p.slug}: {", ".join(c["id"] for c in failed)} did not pass on {unfinished}; not moved to {final}\n'
                      + '\n'.join(line for c in failed for line in (c['fail_lines'] or [c['output_tail']])))
    final.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(unfinished), str(final))
    log = (req.get('folders') or {}).get('holds_log')
    if log:
        log = Path(log)
        kept = json.loads(log.read_text()) if log.exists() else {}
        kept[p.slug] = holds
        log.write_text(json.dumps(kept, indent=1))
    result['cut'] = str(final)
    result['seconds_made'] = round(media.probe_dur(final), 3)
    return result


def cut_spec(req, p, final, dur, specs, said, asked, work, renderer, oid, aspects):
    """the whole cut as one spec: every graphics event moved to the cut's seconds and its id prefixed by its segment's, every spoken
    word in the cut's seconds (words.json), the voiced lines' words (voice-words.json) and the segments' notes merged by the
    renderer's rules. Written to folders.specs/<slug>.json when the request names that folder, and rendered from with id oid."""
    words, voice = work / 'words.json', work / 'voice-words.json'
    words.write_text(json.dumps({'source': str(final), 'timing': 'word', 'words': said}, indent=1))
    voice.write_text(json.dumps({'source': str(final), 'timing': 'word', 'words': asked}, indent=1))
    events = [e for at, sid, ev, _ in specs for e in renderer.prefixed(ev, at, sid)]
    refs = req.get('refs') or {}
    values = {'cut': ref(final, refs.get('cut_relative_to')), 'plan': ref(p.file, refs.get('plan_relative_to')), 'duration': round(dur, 3),
              'overlay_file': str(renderer.render_out(work / 'gfx', oid) / renderer.row['outputs']['overlay']),
              'aspects': [a[0] for a in aspects], 'voice_words': str(voice) if asked else None, 'spoken_words': str(words), 'events': events}
    notes = renderer.merge_notes([sp for _, _, _, sp in specs], p.slug)
    spec = merged(renderer.spec('cut', {**values, 'id': p.slug}), notes)
    for_render = merged(renderer.spec('cut', {**values, 'id': oid}), notes)
    specs_folder = (req.get('folders') or {}).get('specs')
    if specs_folder:
        out = Path(specs_folder) / f'{p.slug}.json'
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(spec, indent=1))
        file = out
    else:
        file = renderer.spec_file(work / 'gfx', oid)
    return {'file': str(file), 'spec': spec, 'for_render': for_render}



def slides(req, p):
    """each slide drawn by the renderer as one PNG at the plan's one aspect, and all of them in order as one PDF; both made in the
    work folder and moved to the folder the person sees only when every page is there"""
    aspects = aspects_of(p.plan, req['pieces'])
    if len(aspects) != 1:
        raise Refused(f"{p.slug}: slides are drawn at one aspect; the plan names {', '.join(a[0] for a in aspects) or 'none'}")
    rules = rules_of(req, aspects[0][1:])
    renderer = graphics.Renderer(req.get('overlay_renderer'), rules)
    g = graphics.Graphics(req['devices'], renderer, None, rules)
    work, seen = folders_of(req, p)
    gfx, made = work / 'gfx', work / 'slides'
    for d in (gfx, made):
        if d.exists():
            shutil.rmtree(d)
    made.mkdir(parents=True)
    pngs = []
    for ident, spec in g.slide_specs(p.plan, p.rows, aspects[0]):
        png = made / f'slide-{len(pngs) + 1:02d}.png'
        stills = sorted(renderer.render(gfx, spec, ident, stills=[0]).glob("*.png"))
        if len(stills) != 1:
            raise Refused(f'{p.slug}: the renderer drew {len(stills)} pictures for one slide')
        shutil.copyfile(stills[0], png)
        pngs.append(png)
    pages = [Image.open(x).convert('RGB') for x in pngs]
    if any(x.size != (aspects[0][1], aspects[0][2]) for x in pages):
        raise Refused(f'{p.slug}: a slide is not {aspects[0][0]}; nothing moved to {seen}')
    pdf = work / f'{p.slug}.pdf'
    pages[0].save(pdf, save_all=True, append_images=pages[1:], resolution=72, quality=95)
    out = seen / p.slug
    if out.exists():
        shutil.rmtree(out)
    seen.mkdir(parents=True, exist_ok=True)
    shutil.move(str(made), str(out))
    shutil.move(str(pdf), str(seen / f'{p.slug}.pdf'))
    return {'slug': p.slug, 'pdf': str(seen / f'{p.slug}.pdf'), 'slides': [str(out / x.name) for x in pngs], 'aspect': aspects[0][0]}
