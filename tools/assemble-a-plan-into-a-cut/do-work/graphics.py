"""The cut's graphics: laid out here, drawn by the request's overlay renderer.

Nothing here knows what a graphic looks like. Every event the renderer reads is a template in the request's "devices" (what to
draw) and "overlay_renderer" (how its specs are shaped); this module measures the numbers those templates name (text lines that
fit, positions clear of the face, word times, backing strength) and fills them in (read-data/fill.py).

Device rows (DATA, README: Devices):
  tag            a one-line disclosure tag: measure {font, size, pad_em}, y, height_em, inset {left, right}, event
  label          a short label over a recorded span: text, measure, height_em, inset, gap_below_tag, at, hold_s, min_hold_s,
                 end_room_s, exit_s, events
  recreated      the tag of a span whose voice was recreated: words, at, leaves_before_end_s
  recorded       the graphics over a recorded span: heights (below the tag's own), probe_room_s, tail_s, spec,
                 spec_with_plan_graphics
  voiced_line    the graphics over a voiced line: tag_at, out_before_end_s, tag_leaves_s, text_bottom_share, spec, styles {name: style}
  caption        the words of a sound-only span: font, size, center_y, wrap_width, line_height, fade_s, min_up_s, out_room_s,
                 strip_end, tail_s, backing_pad, chunk, event
  backing        a soft backing under light text: contrast, percentile, alpha [min, max], event
  plan_graphics  a plan segment's own graphics: times {key, value}, notes, position_key, mirror_keys, mirror
  slide          one still per slide segment: event, rotations
"""
import json
import os
import re
import shutil
import subprocess
import textwrap
from pathlib import Path

import numpy as np
from PIL import Image, ImageFont

import faces
from fill import Refused, fill, merged
from timing import caption_chunks, shifted, times_of, word_times

_FONTS = {}


def font(spec, size):
    """a font file at size, or Pillow's own font for the font "pillow-default" """
    key = (spec, size)
    if key not in _FONTS:
        if spec == 'pillow-default':
            _FONTS[key] = ImageFont.load_default(size)
        elif not spec or not os.path.isfile(spec):
            raise Refused(f'font {spec} is not a file: give a font file path ({{"here": ...}}) or "pillow-default"')
        else:
            _FONTS[key] = ImageFont.truetype(spec, size)
    return _FONTS[key]


def measure(m, text):
    """the width a one-line graphic takes: the text's length in its font plus pad_em of its size"""
    return int(font(m['font'], m['size']).getlength(text) + m['pad_em'] * m['size'])


def wrap(text, fnt, width):
    lines = []
    for word in text.split():
        if lines and fnt.getlength(lines[-1] + ' ' + word) <= width:
            lines[-1] += ' ' + word
        else:
            lines.append(word)
    return lines


def balanced(text, fnt, width):
    """as few lines as wrap gives at width, each as near the same length as they can be (no one-word last line)"""
    lines = wrap(text, fnt, width)
    w = width
    while w > 200 and len(wrap(text, fnt, w - 20)) == len(lines):
        w -= 20
    return wrap(text, fnt, w)


def lum(png, size):
    """WCAG relative luminance per pixel of a frame, at size (width, height)"""
    c = np.asarray(Image.open(png).convert('RGB').resize(size), dtype=np.float32) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]


class Graphics:
    """the devices, the renderer and the face reader of one cut"""

    def __init__(self, devices, renderer, reader, rules):
        self.d, self.r, self.reader, self.rules = devices, renderer, reader, rules
        self.W, self.H = rules['frame']['width'], rules['frame']['height']
        self.safe = devices.get('safe_margin_px', 0)

    # ------------------------------------------------------------ shared pieces
    def x_of(self, left, width, inset):
        return self.safe + inset['left'] if left else self.W - self.safe - inset['right'] - width

    def backing(self, png, box, at, out):
        """the backing under light text on a still: dark enough that the brightest pixels under the text (percentile) give light
        text the contrast asked for, held to alpha [min, max]"""
        b = self.d['backing']
        x0, y0, x1, y1 = (max(0, int(v)) for v in box)
        p = float(np.percentile(lum(png, (self.W, self.H))[y0:y1, x0:x1], b['percentile']))
        lo, hi = b['alpha']
        alpha = min(hi, max(lo, 1 - (1.05 / b['contrast'] - 0.05) / max(p, 1e-3)))
        return fill(b['event'], {'box': [round(v) for v in box], 'alpha': round(alpha, 2), 'at': round(at, 3), 'out': round(out, 3)})

    def tag(self, ident, words, left, at, out, y=None):
        t = self.d['tag']
        x = self.x_of(left, measure(t['measure'], words), t['inset'])
        values = {'id': ident, 'words': words, 'x': x, 'y': t['y'] if y is None else y, 'at': round(at, 3), 'out': round(out, 3)}
        return fill(t['event'], values, 'left' if left else 'right')

    def tag_height(self):
        t = self.d['tag']
        return t['height_em'] * t['measure']['size']

    # ------------------------------------------------------------ over a voiced line
    def voiced_line(self, style_name, text, qdur, heard, frame, tag_words):
        """(events, overlay seconds) of one voiced line held for qdur seconds over the still frame; heard: the line's word times"""
        v = self.d['voiced_line']
        if style_name not in v['styles']:
            raise Refused(f'style {style_name} is not one of the voiced_line styles: {", ".join(v["styles"])}')
        st = v['styles'][style_name]
        left = faces.away_left(self.reader, frame, self.rules)
        out = qdur - v['out_before_end_s']
        tag_left = left if st.get('tag_side') is None else st['tag_side'] == 'left'
        uses = {'tag': self.tag(v['tag_id'], tag_words, tag_left, v['tag_at'], out - v['tag_leaves_s'])}
        top = self.d['tag']['y'] + self.tag_height() + st['top_gap']
        block = st['block']
        values = {'out': round(out, 3), 'top': top, 'y': top + block.get('y_offset', 0)}
        if 'wrap_chars' in block:
            lines = textwrap.wrap(text, block['wrap_chars'])
            values.update({'size': block['sizes'][0]})
        else:
            bottom = int(self.H * v['text_bottom_share']) - block['bottom_room']
            for size in block['sizes']:
                fnt = font(block['font'], size)
                lines = balanced(text, fnt, block['wrap_width'])
                asc, desc = fnt.getmetrics()
                bh = int((asc + desc) * block['line_height']) * len(lines)
                if top + bh <= bottom:
                    break
            bw = max(fnt.getlength(line) for line in lines) + 2 * int(size * block.get('pad_side_em', 0))
            x0 = self.x_of(left, bw, block['inset'])
            values.update({'size': size, 'x0': round(x0), 'x1': round(x0 + bw)})
            if 'backing' in st:
                bk = st['backing']
                pl, pt, pr, pb = bk['pad']
                uses['backing'] = self.backing(frame, (x0 - pl, top - pt, x0 + bw + pr, top + bh + pb), bk['at'], out + bk['after_out_s'])
            if 'typing' in block:
                ty = block['typing']
                speak = (heard[-1]['end'] if heard else qdur - ty['fallback_tail_s']) - ty['lead_s']
                values['chars_per_s'] = round(min(ty['max'], max(ty['min'], len(''.join(lines)) / max(1.0, speak))), 2)
        values.update({'text': '\n'.join(lines), 'times': word_times(' '.join(lines).split(), heard, qdur)})
        side = 'left' if left else 'right'
        ev = [uses[item['use']] if isinstance(item, dict) and set(item) == {'use'} else fill(item, values, side) for item in st['events']]
        return ev, qdur + st['tail_s']

    # ------------------------------------------------------------ over a recorded span
    def label_text(self, label):
        return fill(self.d['label']['text'], {'label': label})

    def recorded_size(self, label, recreated):
        """(width, height) of the side block: the recreated-voice tag and the label, stacked"""
        widths, height = [0], 0
        if recreated:
            widths.append(measure(self.d['tag']['measure'], self.d['recreated']['words']))
            height += self.tag_height()
        if label:
            lb = self.d['label']
            widths.append(measure(lb['measure'], self.label_text(label)))
            height += (lb['gap_below_tag'] if recreated else 0) + lb['height_em'] * lb['measure']['size']
        return max(widths), height

    def recorded_events(self, label, recreated, dur, left, top):
        """the label and the recreated-voice tag of one span, at the place found clear of the face"""
        ev, end = [], 0.0
        if recreated:
            rc = self.d['recreated']
            ev.append(self.tag(rc['tag_id'], rc['words'], left, rc['at'], dur - rc['leaves_before_end_s'], top))
            end = dur
        if label:
            lb = self.d['label']
            out = max(lb['min_hold_s'], min(lb['hold_s'], dur - lb['end_room_s']))
            text = self.label_text(label)
            values = {'text': text, 'x': self.x_of(left, measure(lb['measure'], text), lb['inset']),
                      'y': top + self.tag_height() + lb['gap_below_tag'] if recreated else top, 'at': lb['at'], 'out': round(out, 3)}
            ev += [fill(e, values, 'left' if left else 'right') for e in lb['events']]
            end = max(end, out + lb['exit_s'])
        return ev, end + self.d['recorded']['tail_s']

    def place_recorded(self, src, chain, a, dur, label, recreated, work, name):
        """(left, top) of the side block of a recorded span"""
        rec, lb = self.d['recorded'], self.d.get('label', {})
        hold = lb.get('hold_s', 0) + rec['probe_room_s']
        size = self.recorded_size(label, recreated)
        inset = {k: self.safe + v for k, v in self.d['tag']['inset'].items()}
        y = self.d['tag']['y']
        band = (y, y + self.rules['placement']['calm_probe']['tag_sizes_tall'] * self.d['tag']['measure']['size'])
        return faces.corner(self.reader, src, chain, a, dur if recreated else min(dur, hold), size, inset, [y, *rec['heights']], (hold, band),
                            work, name, self.rules)

    # ------------------------------------------------------------ captions of a sound-only span
    def captions(self, words, a, dur, png):
        """the words of a sound-only span over the still png, a = the source second at the span's first frame, cut into chunks; each
        chunk complete when it lands, each word lit on its time, one backing under the band"""
        c = self.d['caption']
        chunks = caption_chunks(words, c['chunk'])
        fnt = font(c['font'], c['size'])
        asc, desc = fnt.getmetrics()
        lh = int((asc + desc) * c['line_height'])
        ev, widest, tallest, gone = [], 0, 1, dur
        for n, chunk in enumerate(chunks):
            t0 = max(0.0, chunk[0]['start'] - a)
            t1 = (chunks[n + 1][0]['start'] - a) if n + 1 < len(chunks) else dur
            shown = [x for w in chunk for x in w['text'].split()]
            shown[-1] = shown[-1].rstrip(c['strip_end'])
            lines = balanced(' '.join(shown), fnt, c['wrap_width'])
            widest, tallest = max(widest, max(fnt.getlength(line) for line in lines)), max(tallest, len(lines))
            times = [round(max(t0, w['start'] - a), 3) for w in chunk for _ in w['text'].split()]
            out = max(t0 + c['min_up_s'], t1 - c['fade_s'] - c['out_room_s'])
            gone = max(gone, out + c['fade_s'])
            ev.append(fill(c['event'], {'id': f'c{n}', 'text': '\n'.join(lines), 'size': c['size'], 'center': [self.W // 2, c['center_y']],
                                        'ready_at': round(t0, 3), 'times': times, 'out': round(out, 3)}))
        half = tallest * lh / 2
        pl, pt, pr, pb = c['backing_pad']
        cy = c['center_y']
        ev.insert(0, self.backing(png, (self.W / 2 - widest / 2 - pl, cy - half - pt, self.W / 2 + widest / 2 + pr, cy + half + pb), 0.0, gone))
        return ev, gone + c['tail_s']

    # ------------------------------------------------------------ a plan segment's own graphics
    def plan_graphics(self, s, a, src, chain, sound_only, work, name):
        """(events, end) of a segment's own graphics (DATA in the plan, times in the source's seconds): each moved to the segment's
        seconds, its notes left out, and mirrored when the face covers the columns it really covers (measured by the renderer) on
        more frames than the mirrored columns"""
        pg, tf = self.d['plan_graphics'], self.r.time_fields
        pad = self.rules['placement']['face_pad_px']
        ev, end = [], 0.0
        for g in s.get('graphics', []):
            if g.get(pg['times']['key']) != pg['times']['value']:
                raise Refused(f"segment {s['clip']} {s['from']}: graphic {g.get('id')} gives {pg['times']['key']} as "
                              f"{g.get(pg['times']['key'])}; the cutter reads {pg['times']['key']}: {pg['times']['value']}")
            e = shifted({k: v for k, v in g.items() if k not in pg['notes']}, -a, tf)
            t0, t1 = min(times_of(g, tf)), max(times_of(g, tf))
            boxes = [] if sound_only else self.reader.boxes(src, chain, t0, t1 - t0, work, f"{name}-{g['id']}", self.rules['placement']['face_frames'])
            x0, x1 = self.r.opaque_columns(e, work, f"{name}-{g['id']}")

            def over(a0, a1):
                return sum(1 for fx, _, fw, _ in boxes if fx - pad < a1 and fx + fw + pad > a0)
            key = pg['position_key']
            if key in e and over(x0, x1) > over(self.W - x1, self.W - x0):
                e[key] = [e[key][0] + (self.W - x1) - x0, e[key][1]]
                for k in pg['mirror_keys']:
                    if e.get(k) in pg['mirror']:
                        e[k] = pg['mirror'][e[k]]
            ev.append(e)
            end = max(end, max(times_of(e, tf)) + self.r.exit_s)
        return ev, end

    # ------------------------------------------------------------ slides
    def slide_specs(self, plan, rows, aspect):
        """one renderer still spec per slide segment, in plan order, at the plan's aspect (label, width, height). The slide whose text
        is the plan field the row's cover.from names is the cover, drawn only when the plan field cover.when.field matches
        cover.when.matches; every other slide carries all the body texts as fit_with, so one type size fits them all."""

        def cover_of(s, row):
            rule = row.get('cover')
            return bool(rule) and s['text'] == plan.get(rule['from'])

        def cover_allowed(row):
            when = row['cover']['when']
            return re.search(when['matches'], plan.get(when['field']) or '') is not None
        drawn = [s for s in plan['segments'] if rows[s['kind']]['piece'] != 'skip' and (not cover_of(s, rows[s['kind']]) or cover_allowed(rows[s['kind']]))]
        body = [s['text'] for s in drawn if not cover_of(s, rows[s['kind']])]
        sl = self.d['slide']
        specs = []
        for s in drawn:
            row, n = rows[s['kind']], len(specs) + 1
            cover = cover_of(s, row)
            event = fill(sl['event'], {'text': s['text'], 'label': plan[row['label_from']], 'cover': cover, 'fit_with': None if cover else body,
                                       'backdrop': row['backdrop'], 'rot': sl['rotations'][(n - 1) % len(sl['rotations'])]})
            ident = self.r.ident(f'slide{n:02d}', '1')
            specs.append((ident, self.r.spec('slide', {'id': ident, 'width': aspect[1], 'height': aspect[2], 'events': [event]})))
        return specs


class Renderer:
    """the request's overlay renderer: a command that reads a spec file and writes an overlay with alpha, its sound and its
    timeline, or with stills only those frames (README: The overlay renderer)"""

    def __init__(self, row, rules):
        need = ('argv', 'spec_file', 'out_folder', 'outputs', 'time_fields', 'id_fields', 'specs', 'cut_spec_merge', 'exit_s')
        missing = [k for k in need if k not in (row or {})]
        if missing:
            raise Refused(f'overlay_renderer lacks {", ".join(missing)} (README: The overlay renderer)')
        self.row, self.rules = row, rules
        self.time_fields, self.exit_s = row['time_fields'], row['exit_s']
        self.mark = row.get('id_mark', '')

    def ident(self, first, *rest):
        return '-'.join(p for p in (first, self.mark, *rest) if p)

    def spec(self, kind, values):
        """the renderer's spec template of this kind, filled; width and height are the cut's frame unless values give them"""
        return fill(self.row['specs'][kind], {'width': self.rules['frame']['width'], 'height': self.rules['frame']['height'], **values})

    def render(self, folder, spec, ident, stills=()):
        """the renderer run on spec under folder; returns its out folder"""
        values = {'folder': str(folder), 'id': ident, 'stills': [str(s) for s in stills]}
        spec_file = self.spec_file(folder, ident)
        spec_file.parent.mkdir(parents=True, exist_ok=True)
        spec_file.write_text(json.dumps(spec, indent=1))
        argv = [str(a) for a in fill(self.row['argv'], values) + (fill(self.row.get('stills_argv', []), values) if stills else [])]
        r = subprocess.run(argv, env={**os.environ, **fill(self.row.get('env', {}), values)}, capture_output=True, text=True)
        if r.returncode:
            raise Refused(f"{ident}: overlay render failed\n{r.stdout[-1500:]}\n{r.stderr[-1500:]}")
        return self.render_out(folder, ident)

    def spec_file(self, folder, ident):
        return Path(fill(self.row['spec_file'], {'folder': str(folder), 'id': ident, 'stills': []}))

    def render_out(self, folder, ident):
        return Path(fill(self.row['out_folder'], {'folder': str(folder), 'id': ident, 'stills': []}))

    def opaque_columns(self, e, work, name):
        """(x0, x1): the columns graphic e covers while it is up, from the renderer itself: e alone as transparent stills across its
        own time, and the union of their opaque boxes"""
        g = self.rules['graphics']
        ts = times_of(e, self.time_fields)
        t0, t1 = min(ts), max(ts)
        gfx = work / 'gfx-measure' / name
        ident = self.ident('measure', name)
        spec = self.spec('measure', {'id': ident, 'duration': round(t1 + g['measure_tail_s'], 3), 'events': [e]})
        out = self.render(gfx, spec, ident, stills=[round(t0 + (t1 - t0) * f, 3) for f in g['measure_at']])
        boxes = [Image.open(p).getchannel('A').point(lambda v: 255 if v > g['alpha_threshold'] else 0).getbbox() for p in sorted(out.glob('*.png'))]
        boxes = [b for b in boxes if b]
        shutil.rmtree(gfx, ignore_errors=True)
        if not boxes:
            raise Refused(f"graphic {e.get('id')}: nothing opaque on screen between {t0:.2f} and {t1:.2f} s")
        return min(b[0] for b in boxes), max(b[2] for b in boxes)

    def prefixed(self, events, at, owner):
        """the events of one segment moved to the cut's seconds, each id and every id it names prefixed by the segment's"""
        idf = self.row['id_fields']
        out = []
        for e in events:
            e = shifted(e, at, self.time_fields)
            if idf['id'] in e:
                e[idf['id']] = f"{owner}-{e[idf['id']]}"
            for ref in idf['refs']:
                if ref in e:
                    e[ref] = [f'{owner}-{x}' for x in e[ref]]
            out.append(e)
        return out

    def merge_notes(self, specs, name):
        """the segments' spec-level notes merged into the cut's by the renderer's merge rule per key: same (one value per inner key,
        two differing refused), last (later segments win) or join (distinct texts joined)"""
        out = {}
        for key, how in self.row['cut_spec_merge'].items():
            if how == 'join':
                said = []
                for sp in specs:
                    if sp.get(key) and sp[key] not in said:
                        said.append(sp[key])
                if said:
                    out[key] = '; '.join(said)
                continue
            got = {}
            for sp in specs:
                for k, v in (sp.get(key) or {}).items():
                    if how == 'same' and got.setdefault(k, v) != v:
                        raise Refused(f'{name}: segments give {key} {k} as {got[k]} and {v}; one overlay takes one value per {key} key')
                    got[k] = v
            out[key] = got
        return out


def recorded_spec(graphics, ident, ov, events, plan_graphics_used):
    """the renderer spec of one recorded span's graphics"""
    d = graphics.d['recorded']
    notes = merged(d.get('spec', {}), d.get('spec_with_plan_graphics', {})) if plan_graphics_used else d.get('spec', {})
    return merged(graphics.r.spec('segment', {'id': ident, 'duration': round(ov, 3), 'events': events}), fill(notes, {}))


def voiced_spec(graphics, ident, ov, events, hold):
    d = graphics.d['voiced_line']
    return merged(graphics.r.spec('segment', {'id': ident, 'duration': round(ov, 3), 'events': events}),
                  fill(d.get('spec', {}), {'hold_s': round(hold, 5)}))
