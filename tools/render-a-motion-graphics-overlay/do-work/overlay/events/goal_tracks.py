"""goal_tracks (lane ch5): "every bite moves me closer to my goals" drawn as what it means: one track per goal (protein,
other nutrients) from a start mark to a goal flag on a graph-paper card, and a marker per track that moves toward the flag
in small hops, one hop per bite, as he says it. A track the food does not move stays put and gets its word ("deficient");
what he wants to make is shown as a dashed path and a hollow marker reaching the flag, so wish and fact never look the same
(technique: progress tracks / board-game track, after the Vox explainer move "show the mechanism, not the words";
library/techniques/goal-tracks.md). Positions are qualitative (closer / not closer, as he says it), never invented numbers.

    {"type": "goal_tracks", "id": "goals", "pos": [x, y], "size": [w, h], "title": "...", "food": "ice cream",
     "at": s, "out": s, "tracks": ["protein", "other nutrients"],
     "moves": [{"track": 0, "to": 0.92, "at": s, "dur": s, "steps": 5}],
     "words": [{"track": 1, "text": "deficient", "at": s}],
     "wish": [{"track": 1, "to": 1.0, "at": s, "dur": s}]}

Ink on graph paper (synthetic-2a909ed31b3a: Kalam for the hand-lettered words); one key click per hop (synthetic-99c2095c6735)."""
import os
import sys
from PIL import Image, ImageDraw
from overlay import kit
from overlay import look, stage
from overlay.helpers import paper_pieces as K

START, GOAL = 0.06, 1.0


def _hops(u, steps):
    """0..1 over steps hops, each hop easing out into place (a bite, then a pause)."""
    if u >= 1:
        return 1.0
    k = int(u * steps)
    f = u * steps - k
    return (k + K.ease_out(min(1.0, f / 0.55))) / steps


def ev_goal_tracks(self, e):
    sid = e.get('id', 'goals')
    W, H = e['size']
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    card = Image.new('RGBA', (W, H), (247, 247, 241, 255))
    d = ImageDraw.Draw(card)
    for k in range(0, max(W, H), 24):
        d.line([(k, 0), (k, H)], fill=kit.col('grid') + (110,), width=1)
        d.line([(0, k), (W, k)], fill=kit.col('grid') + (110,), width=1)
    card = stage.apply_texture(card, 'sheet', 23, 0.3)
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).polygon(stage.torn_polygon(W, H, 5, 29, step=9), fill=255)
    card.putalpha(m)
    ink = K.INK + (255,)
    ft = K.face(e.get('title_font', 'Kalam-Bold.ttf'), e.get('title_px', 40))
    fl = K.face(e.get('label_font', 'Kalam-Bold.ttf'), e.get('label_px', 34))
    fw = K.face(e.get('word_font', 'PermanentMarker-Regular.ttf'), e.get('word_px', 34))
    d = ImageDraw.Draw(card)
    d.text((W / 2, 28), e['title'], font=ft, fill=ink, anchor='mt')
    if e.get('food'):
        d.text((W / 2, 28 + e.get('title_px', 40) * 1.25), e['food'], font=fl, fill=K.INK + (200,), anchor='mt')
    n = len(e['tracks'])
    top = 28 + e.get('title_px', 40) * 1.25 + (e.get('label_px', 34) * 1.6 if e.get('food') else 20)
    gap = (H - top - 40) / n
    x0, x1 = 44, W - 110
    ys = [top + gap * (i + 0.62) for i in range(n)]
    for i, (lab, y) in enumerate(zip(e['tracks'], ys)):
        d.text((x0, y - 46), lab, font=fl, fill=ink, anchor='lb')
        d.line([(x0, y), (x1, y)], fill=ink, width=4)
        for k in range(9):  # tick marks: the bites
            xx = x0 + (x1 - x0) * k / 8
            d.line([(xx, y - 9), (xx, y + 9)], fill=ink, width=2)
        # the goal flag at the end of the track
        d.line([(x1 + 30, y + 14), (x1 + 30, y - 58)], fill=ink, width=4)
        d.polygon([(x1 + 32, y - 58), (x1 + 78, y - 46), (x1 + 32, y - 34)], fill=ink)
    d.text((x1 + 30, ys[-1] + 34), 'goal', font=fl, fill=ink, anchor='mt')
    moves = [dict(mv, at=self.T(mv['at'])) for mv in e.get('moves', [])]
    wish = [dict(w, at=self.T(w['at'])) for w in e.get('wish', [])]
    words = [dict(w, at=self.T(w['at'])) for w in e.get('words', [])]

    def pos_on(track, tt, items, hops=True):
        p, seen = START, False
        for mv in items:
            if mv['track'] != track or tt < mv['at']:
                continue
            u = min(1.0, (tt - mv['at']) / mv['dur'])
            p = p + (mv['to'] - p) * (_hops(u, mv.get('steps', 1)) if hops else K.ease_out(u))
            seen = True
        return p, seen
    cache = {}

    def picture(tt):
        state = []
        for i in range(n):
            p, _ = pos_on(i, tt, moves)
            q, has_wish = pos_on(i, tt, wish, hops=False)
            state.append((round(p, 3), round(q, 3) if has_wish else None))
        wl = tuple(w['at'] <= tt for w in words)
        key = (tuple(state), wl)
        if key in cache:
            return cache[key]
        im = card.copy()
        dd = ImageDraw.Draw(im)
        for i, ((p, q), y) in enumerate(zip(state, ys)):
            px = x0 + (x1 - x0) * p
            if q is not None and q > p:  # the wish: a dashed path ahead of the marker and a hollow marker
                qx = x0 + (x1 - x0) * q
                xx = px + 22
                while xx < qx - 22:
                    dd.line([(xx, y - 22), (min(xx + 14, qx - 22), y - 22)], fill=ink, width=3)
                    xx += 24
                dd.ellipse([qx - 17, y - 39, qx + 17, y - 5], outline=ink, width=4)
            dd.ellipse([px - 17, y - 17, px + 17, y + 17], fill=ink)
        for w, on in zip(words, wl):
            if on:
                y = ys[w['track']]
                p = state[w['track']][0]
                dd.text((x0 + (x1 - x0) * p + 30, y + 22), w['text'], font=fw, fill=ink, anchor='lt')
        out = stage.shadowed(im.rotate(-e.get('rot', 1.0), expand=True, resample=Image.BICUBIC), look.R['card']['shadow'])[0]
        if len(cache) > 12:
            cache.pop(next(iter(cache)))
        cache[key] = out
        return out
    x, y = e['pos']
    K.moving(self, sid, picture, x, y, t_in, t_out, enter='right', exit=e.get('exit', 'right'), order=58, drift=False, smooth=False)
    self.sound('slide_in', t_in)
    for mv in moves:
        for k in range(mv.get('steps', 1)):
            self.sound(['click1', 'click2'][k % 2], mv['at'] + mv['dur'] * k / mv.get('steps', 1))
    for w in words:
        self.sound('marker_long', w['at'])
    for w in wish:
        self.sound('rustle', w['at'])
    self.sound('slide_out', t_out)
