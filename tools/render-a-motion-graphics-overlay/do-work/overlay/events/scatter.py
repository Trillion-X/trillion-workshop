"""The `scatter` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:528."""

from overlay import kit


# ---------- exits as data ----------
def ev_scatter(self, e):
    """Each target leaves in its own direction: dirs[i] is a compass word (N, NE, E, SE, S, SW, W, NW) or [dx, dy];
    stagger_s between targets (in list order). One exit sound per direction group, different from the entry."""
    t = self.T(e['at'])
    groups = {}
    for i, (sid, d) in enumerate(zip(e['targets'], e['dirs'])):
        dx, dy = kit.compass(d)
        ti = t + i * e.get('stagger_s', 0.0)
        for sp in self.byid(sid):
            sp.t_out, sp.out_dx, sp.out_dy = ti, dx, dy
        groups.setdefault(str(d), ti)
    for ti in sorted(set(groups.values())):
        self.sound(e.get('sound', 'slide_out'), ti)
