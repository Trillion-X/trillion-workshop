"""The `tear_exit` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:822."""

from overlay import kit, stage


def ev_tear_exit(self, e):
    """The sheet and everything on it splits along a ragged vertical tear; the left half falls left, the right half
    falls right. Then the light leak, then the footage."""
    t = self.T(e['at'])
    self.exit_t = t + 0.1
    split = e.get('x', stage.W * 0.5)
    part = kit.tear_part(e)
    for sp in self.sprites:
        if sp.id == 'pause' or sp.t_out is not None:
            continue
        if sp.id == 'paper':
            sp.tear = (t, split, part)
            continue
        st = sp.state(t)
        if st is None:
            continue
        img, x, y, *_ = st
        left = x + img.width / 2 < split
        sp.t_out, sp.out_dx, sp.out_dy = t + 0.04, (-1 if left else 1) * part['dx'], part['dy']
    self.sound('tear', t)
    self.sound('slide_out', t + 0.12)
