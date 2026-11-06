"""hold_still (round 8, the narrator's analysis beat): the picture held under the narrator is a chosen frame of the same shot, not the frame the cut happens on.
The cut has to sit where his word has finished and "So" has not begun (frame 3156, which caught him mid-blink with his mouth open), so the
FilmCraft hold freezes that frame; this event lays a full-frame still of a better frame of the same shot over the hold (eyes fully open, mouth closed,
scored with Apple Vision face landmarks, tools-round-3/eyes_r8_analysis.swift) and takes it away when the hold ends, so the footage resumes from the
frame the cut was made on. The still is the graded render of his cut (work/ch1-base-1080.mp4), the same pixels the hold would show.

    {"type": "hold_still", "id": "hs", "image": path, "out": seconds, "covers_a_roll": true, "until": seconds}

It sits under every other piece (order 1) and is declared a full-frame cover, so film-qa reads the frame as covered, not as graphics on his face."""
from PIL import Image
from overlay import kit, look, stage
from overlay.kit import SmoothSprite


def ev_hold_still(self, e):
    img = Image.open(e['image']).convert('RGBA').resize((stage.W, stage.H))
    t_out = self.T(e['out'])

    def dyn(tt):
        return (img, 0, 0) if tt < t_out else (None, 0, 0)
    sp = SmoothSprite(self, e.get('id', 'hs'), None, 0, 0, 0.0, 'none', 0, order=1, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.boxes.append((e.get('id', 'hs'), 0.0, t_out, 0, 0, stage.W, stage.H))
