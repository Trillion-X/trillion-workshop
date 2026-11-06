"""The `role` event. Ported from narrator/tools/render_correction.py:373."""

from overlay import look, stage


def ev_role(self, e):
    fnt = stage.font(look.R['fonts']['role'], e['size'] * stage.K)
    t = self.T(e['at']); text = e['text']; cps = look.R['type_on']['chars_per_s'] * 1.3
    cache = {}

    def dyn(tt):
        n = min(len(text), int((tt - t) * cps) + 1)
        if n not in cache:
            cache[n] = self.type_on_img(text, fnt, stage.rgb('role_green'), n)
        return cache[n], e['pos'][0] * stage.K, e['pos'][1] * stage.K
    sp = stage.Sprite(e.get('id', 'role'), None, 0, 0, t, 'none', 0, order=60)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('key', t)
