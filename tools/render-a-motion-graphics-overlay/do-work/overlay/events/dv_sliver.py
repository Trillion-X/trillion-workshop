"""dv_sliver (lane ch5): how small an amount is, shown against the whole it is measured by: a long empty bar for the full
Daily Value, and the amount as the sliver of it that actually fills (technique: Daily Value sliver, after Unit Grid Fill
#245's rule "keep the denominator visible" and the nutrition-label %DV; library/techniques/daily-value-sliver.md). For a
claim like "nearly no protein" the empty bar says it before any number does.

    {"type": "dv_sliver", "id": "pop", "pos": [x, y], "w": 560, "at": s, "out": s, "enter": "right", "exit": "right",
     "title": "1 cup of air-popped popcorn", "amount": {"text": "1 g protein", "value": 1, "at": s},
     "dv": {"value": 50, "label": "2% of the 50 g Daily Value", "at": s}, "source": "Source: USDA, FDA"}

White SF Pro over footage with the soft wide shadow (synthetic-4b111b631333), the bar a white outline; the bar draws out to
its full length first (the whole), then the sliver fills (the part). A smooth slide in and out with motion blur, still
while it is up; or, with enter/exit 'none', it builds in place and leaves with the cut of the shot it sits on (gone at out +
0.34 s). Sounds: the swipe in (or the bar's stroke when it builds in place), a soft tap as the sliver lands, the swish out
(none when it leaves on a cut)."""
import os
import sys

from PIL import Image, ImageDraw
from overlay import kit, look
from overlay import stage
from overlay.kit import ease_out

from overlay.helpers import paper_pieces as K
from overlay.helpers import slide_pieces as C

WHITE = (255, 255, 255)


def ev_dv_sliver(self, e):
    sid = e.get('id', 'dv')
    T = self.T
    W = e.get('w', 560)
    ft = kit.sf('display_semibold', e.get('title_px', 34))
    fa = kit.sf('display_bold', e.get('amount_px', 72))
    fl = kit.sf('text_semibold', e.get('label_px', 30))
    fs = kit.sf('text_medium', e.get('source_px', 22))
    amt, dv = e['amount'], e['dv']
    t_in, t_out, t_amt, t_dv = T(e['at']), T(e['out']), T(amt['at']), T(dv['at'])
    bar_y, bar_h = 168, 46
    H = 330
    cache = {}

    def picture(tt):
        bu = min(1.0, max(0.0, (tt - t_in - 0.1) / 0.45))
        su = min(1.0, max(0.0, (tt - t_amt) / 0.35)) if tt >= t_amt else 0.0
        lu = 1.0 if tt >= t_dv else 0.0
        key = (round(bu, 2), round(su, 2), lu)
        if key in cache:
            return cache[key]
        im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.text((0, 0), e['title'], font=ft, fill=WHITE + (255,))
        if su > 0:
            d.text((0, 50), amt['text'], font=fa, fill=WHITE + (int(255 * min(1.0, su * 2)),))
        bw = (W - 8) * ease_out(bu)
        if bw > 2:
            d.rounded_rectangle([4, bar_y, 4 + bw, bar_y + bar_h], radius=10, outline=WHITE + (255,), width=4)
        if su > 0:
            fw = max(6.0, (W - 8) * amt['value'] / dv['value']) * ease_out(su)
            d.rounded_rectangle([4, bar_y, 4 + fw, bar_y + bar_h], radius=8, fill=WHITE + (255,))
        if lu:
            d.text((0, bar_y + bar_h + 16), dv['label'], font=fl, fill=WHITE + (255,))
            if e.get('source'):
                d.text((0, bar_y + bar_h + 62), e['source'], font=fs, fill=(235, 235, 235, 255))
        out = stage.shadowed(im, look.LOOK['text_shadow'])[0]
        if len(cache) > 10:
            cache.pop(next(iter(cache)))
        cache[key] = out
        return out

    x, y = e['pos']
    C.slide(self, sid, picture, x, y, t_in, t_out, enter=e.get('enter', 'right'), exit=e.get('exit', 'right'), order=60)
    # enter 'none': the card is not carried in, the bar draws itself, so the sound is the stroke of the bar drawing; exit
    # 'none': it leaves with the shot it belongs to (a cut), which carries no sound of its own
    self.sound('card_in' if e.get('enter', 'right') != 'none' else 'strike', t_in)
    self.sound('tap', t_amt)
    if e.get('exit', 'right') != 'none':
        self.sound('card_out', t_out)
