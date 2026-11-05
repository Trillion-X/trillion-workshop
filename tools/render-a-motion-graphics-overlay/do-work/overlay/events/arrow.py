"""The `arrow` event. Ported from narrator/tools/render_correction.py:415."""

from overlay import look, stage


def ev_arrow(self, e, t=None, sid='arrow'):
    a = look.R['arrow']
    t = self.T(e['at']) if t is None else t
    cache = {}

    def dyn(tt):
        fr = round(min(1.0, (tt - t) / a['draw_s']), 2)
        if fr not in cache:
            cache[fr] = self.arrow_img(e['from'], e['to'], e.get('bend', 0), fr, stage.rgb(a['colour']), a['stroke_px'])
        return cache[fr]
    sp = stage.Sprite(sid, None, 0, 0, t, 'none', 0, order=60)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('marker', t)
