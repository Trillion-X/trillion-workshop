"""ch2_sfx (lane ch2, round 2): one sound from chapter 2's sound classes at a time, for an edit that is not drawn (a
punch-in or a cut made in the project) but still needs its own sound (sound-per-element).

    {"type": "ch2_sfx", "kind": "ch2_slide", "at": s, "max_s": 0.3}      kinds: options-ch2/sound/palette.json"""
from overlay.helpers.sound_classes import play


def ev_ch2_sfx(self, e):
    play(self, e['kind'], self.T(e['at']), e.get('max_s'))
