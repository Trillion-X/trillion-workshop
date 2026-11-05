"""object_cutout (lane ch3): the real object he is talking about, cut out of his own footage, slides in beside him and
sits there while his talk keeps playing, then slides back out (device "proof objects pop beside the speaker", DV
library; filmcraft/options-ch3/TECHNIQUES.md#object-cutout-beside-speaker). No label: the object's own printed words say what it is
(synthetic-d2b312484419).

    {"type": "object_cutout", "id": "pack", "image": path, "w": 380, "pos": [x, y], "rot": 4, "at": s, "out": s,
     "enter": "right", "exit": "right"}"""
import os
import sys
from PIL import Image
from overlay.helpers import paper_pieces as K


def ev_object_cutout(self, e):
    im = K.image_piece(e['image'], e['w'], e.get('crop'))
    im = im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC)
    im = K.shadow(im)[0]
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    x, y = e['pos']
    K.moving(self, e.get('id', 'object'), lambda tt: im, x, y, t_in, t_out, enter=e.get('enter', 'right'),
             exit=e.get('exit', 'right'), order=e.get('order', 60))
    self.sound('slide_in', t_in)
    self.sound('slide_out', t_out)
