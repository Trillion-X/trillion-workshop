"""The `slide_out` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:815."""


# ---------- generic move / exits ----------
def ev_slide_out(self, e):
    t = self.T(e['at'])
    for sid in e['targets']:
        for sp in self.byid(sid):
            sp.t_out, sp.out_dx, sp.out_dy = t, e.get('dx', 1300), e.get('dy', 0)
    self.sound(e.get('sound', 'slide_out'), t)
