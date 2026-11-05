"""The `bfull3` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:685."""

from overlay import kit, stage


# ---------- B-roll full frame, every frame ----------
def ev_bfull3(self, e):
    """Muted B-roll filling the frame: e.clips = [{src, start, at, until}] played back to back at the film's frame
    rate (no stop-motion stepping on footage). Order 1: under every graphic."""
    for k, c in enumerate(e['clips']):
        rd = kit.ClipReader(c['src'], c['start'], (stage.W, stage.H), speed=c.get('speed', 1.0))
        # clip k covers frames [na, nu): back-to-back clips share the frame boundary, so no frame of the A-roll and
        # no mixed frame shows between them (a hard cut, no fade)
        na, nu = round(self.T(c['at']) * stage.FPS), round(self.T(c['until']) * stage.FPS)

        def layer(tt, rd=rd, na=na, nu=nu):
            n = round(self.t_exact * stage.FPS)
            if n >= nu:
                return None, 0, 0
            return rd.get(n - na).convert('RGBA'), 0, 0
        sp = kit.SmoothSprite(self, f"{e.get('id', 'bfull')}-{k}", None, 0, 0, (na - 0.25) / stage.FPS, 'none', 0, order=1, jitter=False)
        sp.dynamic = layer
        self.add(sp)
