"""The `sound` event. Ported from filmcraft/options-ch1/tools/opt_overlay.py:70."""


def ev_sound(self, e):
    self.sound(e['kind'], self.T(e['at']))
