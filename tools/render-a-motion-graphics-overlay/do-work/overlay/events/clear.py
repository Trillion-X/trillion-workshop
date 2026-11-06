"""The `clear` event. Ported from narrator/tools/render_correction.py:520."""


def ev_clear(self, e):
    t = self.T(e['at'])
    for sid in e['targets']:
        for sp in self.byid(sid):
            sp.t_out = t
            sp.out_dx, sp.out_dy = e.get('dx', 0), e.get('dy', 0)
    self.sound('whoosh', t)
