"""The `exit` event. Ported from narrator/tools/render_correction.py:649."""


def ev_exit(self, e):
    self.exit_t = self.T(e['at'])
    for sp in self.sprites:
        if sp.t_out is None and sp.id != 'pause':
            sp.t_out, sp.out_dx, sp.out_dy = self.exit_t, 0, 1150
    self.sound('whoosh', self.exit_t)
    self.sound('rip', self.exit_t + 0.02)
