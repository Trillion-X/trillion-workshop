"""route-draw: a marker path drawn across a paper card in step with his words, each station labelled as he names it, the path
ending in a hole, and small paper tags (the things made along the way) dropping off the path onto the card.

Technique: map route animation (awesome-ai-motion #278, MIT): the path is a stroke whose drawn length follows time (stroke
dash offset), 4-6 px line, the station label lands when the line reaches it; here the map is a kraft card and the route is
the rabbit hole of his Byproduct Founder idea.

Spec: {type: route, id, pos: [x, y] card top-left, size: [w, h], rot, at, out, paper,
       path: [[x, y], ...] control points in card px (smoothed),
       title: {text, at, font, size}   written across the top of the card,
       draw: [[t, point], ...]  the line has reached control point `point` (index into path) at time t, eased between keys,
       stations: [{point, text, font, size, dx, dy, anchor}]   label drawn when the line reaches that point,
       hole: {rx, ry}           a dark hole drawn at the path's last point when the line reaches it,
       note: {text, at, pos, font, size}   a pencil word written on the card,
       tags: [{at, text, font, size, from_point, to: [x, y], rot, paper}]   a tag drops from the path to `to` (card px),
       exit: 'cut'              the card is gone at `out` without sliding (a later event grows out of it),
       sounds: {in, draw: [kinds, used in turn], title, note, drop, out}   sound kinds (default card_in, marker, pencil, drop,
                                card_out); separate recordings per stroke keep the strokes from reading as a loop}"""
import math
from PIL import Image, ImageDraw
from overlay import kit
from overlay import look, stage
from overlay.helpers import marker_and_slide as L


def ev_route(self, e):
    w, h = e['size']
    self.seed += 1
    base = L.paper(w, h, e.get('paper', 'kraft'), self.seed, edge_amp=5, step=9)
    seg_n = 30
    pts = L.catmull([tuple(p) for p in e['path']], seg_n)
    cum = L.polyline_length(pts)
    total = cum[-1]
    frac_of = lambda i: cum[min(int(i * seg_n), len(cum) - 1)] / total  # control point index -> fraction of the path
    keys = [(self.T(k[0]), frac_of(k[1])) for k in e['draw']]
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    ink = L.col('ink') + (255,)

    def frac_at(tt):
        if tt <= keys[0][0]:
            return 0.0 if tt < keys[0][0] else keys[0][1]
        for (a, fa), (b, fb) in zip(keys, keys[1:]):
            if tt < b:
                return fa + (fb - fa) * L.ease_in_out((tt - a) / max(b - a, 1e-6), 1.6)
        return keys[-1][1]

    def point_at(f):
        p = L.polyline_prefix(pts, cum, f * total)
        return p[-1]
    tags = []
    for k, tg in enumerate(e.get('tags', [])):
        fnt = L.face(tg.get('font', 'Kalam-Bold.ttf'), tg.get('size', 26))
        tw = int(fnt.getlength(tg['text'])) + 30
        th = int(tg.get('size', 26) * 1.7)
        self.seed += 1
        tp = L.paper(tw, th, tg.get('paper', 'white'), self.seed, edge_amp=2, step=6)
        ImageDraw.Draw(tp).text((tw / 2, th / 2), tg['text'], font=fnt, fill=ink, anchor='mm')
        tp = tp.rotate(tg.get('rot', 0), expand=True, resample=Image.BICUBIC)
        tp, pad = L.shadow(tp, {'dx': 2, 'dy': 4, 'blur': 6, 'opacity': 0.4})
        tags.append((self.T(tg['at']), point_at(frac_of(tg['from_point'])), tuple(tg['to']), tp))
    st_fonts = [L.face(s.get('font', 'PermanentMarker-Regular.ttf'), s.get('size', 30)) for s in e['stations']]
    title_font = L.face(e['title'].get('font', 'PermanentMarker-Regular.ttf'), e['title'].get('size', 44)) if e.get('title') else None
    note_font = L.face(e['note'].get('font', 'Kalam-Bold.ttf'), e['note'].get('size', 30)) if e.get('note') else None
    cache = {}

    def card(tt):
        key = round(tt * L.FPS / r3_hold())
        if key in cache:
            return cache[key]
        im = base.copy()
        d = ImageDraw.Draw(im)
        f = frac_at(tt)
        hole = e.get('hole')
        if hole and f >= 1 - 1e-3:
            hx, hy = pts[-1]
            for k, a in enumerate((90, 160, 235)):
                rx, ry = hole['rx'] * (1 - 0.22 * k), hole['ry'] * (1 - 0.22 * k)
                d.ellipse([hx - rx, hy - ry * 0.5, hx + rx, hy + ry * 1.5], fill=(20, 18, 16, a))
        if f > 0:
            L.marker_line(d, L.polyline_prefix(pts, cum, f * total), ink, e.get('width', 6), seed=3)
            hx, hy = point_at(f)
            if f < 0.998:
                d.ellipse([hx - 6, hy - 6, hx + 6, hy + 6], fill=ink)
        for s, fnt in zip(e['stations'], st_fonts):
            if tt >= keys[0][0] and f + 1e-4 >= frac_of(s['point']):
                x, y = e['path'][s['point']]
                d.multiline_text((x + s.get('dx', 18), y + s.get('dy', 0)), s['text'], font=fnt, fill=ink, anchor=s.get('anchor', 'lm'), spacing=2)
        ti = e.get('title')
        if ti and tt >= self.T(ti['at']):
            d.text((w / 2, 26), ti['text'], font=title_font, fill=ink, anchor='mt')
        nt = e.get('note')
        if nt and tt >= self.T(nt['at']):
            d.text(tuple(nt['pos']), nt['text'], font=note_font, fill=(56, 56, 60, 255))
        for t0, (fx, fy), (tx, ty), tp in tags:
            if tt < t0:
                continue
            u = L.ease_out((tt - t0) / 0.45)
            x = fx + (tx - fx) * u - tp.width / 2
            y = fy + (ty - fy) * u - tp.height / 2 - 40 * math.sin(math.pi * u)
            im.alpha_composite(tp, (int(x), int(y)))
        out = L.shadow(im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC), look.R['card']['shadow'])
        cache.clear()
        cache[key] = out
        return out
    full, pad = card(t_out - 0.01)
    x_end, y_end = e['pos'][0] - pad, e['pos'][1] - pad
    self.safe_box(e.get('id', 'route'), *self.opaque_box(full, x_end, y_end), t_in, t_out)
    side = L.slide_side(e, x_end, full.width)

    cut = e.get('exit') == 'cut'

    def dyn(tt):
        if cut and tt >= t_out:
            return None, 0, 0
        im, _ = card(tt)
        x = L.slide_x(tt, t_in, t_out + (1e9 if cut else 0), x_end, im.width, side)
        if x is None:
            return None, 0, 0
        return im, x, y_end
    sp = stage.Sprite(e.get('id', 'route'), None, 0, 0, t_in, 'none', 0, order=e.get('order', 55), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    snd = dict({'in': 'card_in', 'draw': ['marker'], 'title': 'pencil', 'note': 'pencil', 'drop': 'drop', 'out': 'card_out'}, **e.get('sounds', {}))
    self.sound(snd['in'], t_in)
    strokes = [a for (a, fa), (b, fb) in zip(keys, keys[1:]) if fb > fa]
    for k, a in enumerate(strokes):
        self.sound(snd['draw'][k % len(snd['draw'])], a)
    if e.get('title'):
        self.sound(snd['title'], self.T(e['title']['at']))
    if e.get('note'):
        self.sound(snd['note'], self.T(e['note']['at']))
    for t0, *_ in tags:
        self.sound(snd['drop'], t0 + 0.4)
    if not cut:
        self.sound(snd['out'], t_out)


def r3_hold():
    return stage.HOLD
