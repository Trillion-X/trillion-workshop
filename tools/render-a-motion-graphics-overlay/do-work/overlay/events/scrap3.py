"""The `scrap3` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:509."""
from PIL import Image

from overlay import look, stage


def ev_scrap3(self, e):
    """A typewriter scrap; also returns where its first letter starts so a tick can stay clear of it."""
    self.seed += 1
    img = self.paper_text_img(e['text'], e['size'], e.get('paper', 'crumpled'), self.seed)
    img = img.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC)
    img, pad = stage.shadowed(img, look.R['card']['shadow'])
    t = self.T(e['at'])
    x, y = e['pos'][0] - pad, e['pos'][1] - pad
    self.safe_box(e.get('id', 'scrap'), *self.opaque_box(img, x, y), t)
    intro = e.get('intro', 'slam')  # slam: lands like a stamp; slide: slides in from the right edge (sound-fits-motion)
    sp = self.add(stage.Sprite(e.get('id', 'scrap'), img, x, y, t, 'none' if intro == 'slide' else intro, look.R['card']['slam_s'], order=e.get('order', 50),
                            jitter=bool(e.get('jitter_s'))))
    self.paper_motion(sp, e, t)
    if intro == 'slide':
        d = look.LOOK['slide']['in_s']
        sp.dynamic = lambda tt: (img, x + (1 - stage.ease_out(min(max((tt - t) / d, 0.0), 1.0))) * (stage.W - x + 40), y)
    self.sound({'slam': 'paper', 'slide': 'slide_in', 'pop': 'pop'}[intro], t)
