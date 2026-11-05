"""The `collage3` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:391."""


def ev_collage3(self, e):
    """r2's collage header (each word cut from a different paper), held still: no shake (synthetic-aa5977b6419a)."""
    n0 = len(self.sprites)
    self.ev_collage(e)
    for sp in self.sprites[n0:]:
        sp.jitter = False
        self.safe_box(e.get('id', 'collage'), *self.opaque_box(sp.img, sp.x, sp.y), sp.t_in)
