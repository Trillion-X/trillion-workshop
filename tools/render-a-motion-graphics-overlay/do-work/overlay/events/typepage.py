"""The `typepage` event. Ported from filmcraft/options-ch1/tools/opt_overlay.py:99."""
from PIL import Image, ImageDraw

from overlay import look, stage


def ev_typepage(self, e):
    """Typewriter text typed onto the sheet word by word in step with the narrator: page word k appears at the start of the narrator's
    word from_word + k (the page is his first-person sentence, the narrator says the same words in the third person)."""
    fnt = stage.font(look.R['fonts']['typewriter'], e['size'])
    lines = [l.split(' ') for l in e['text'].split('\n')]
    lh = fnt.getbbox('Hg')[3] * e.get('leading', 1.3)
    times = [self.words.t0 + w['start'] for w in self.words.w[e['from_word']:]]
    flat = [(i, j) for i, l in enumerate(lines) for j in range(len(l))]
    if len(times) < len(flat):
        raise SystemExit(f'typepage: {len(flat)} page words, {len(times)} spoken words left')
    w_px = int(max(fnt.getlength(' '.join(l)) for l in lines) + 20)
    h_px = int(lh * len(lines) + 20)
    cache = {}

    def dyn(tt):
        n = sum(1 for k in range(len(flat)) if times[k] <= tt)
        if n not in cache:
            img = Image.new('RGBA', (w_px, h_px), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            for k in range(n):
                i, j = flat[k]
                x = 10 + fnt.getlength(' '.join(lines[i][:j]) + (' ' if j else ''))
                d.text((x, 10 + i * lh), lines[i][j], font=fnt, fill=stage.rgb(e.get('colour', 'ink')) + (255,))
            cache[n] = img.rotate(e.get('rot', 0), expand=True, resample=Image.BICUBIC) if e.get('rot') else img
        return cache[n], e['pos'][0], e['pos'][1]
    sp = stage.Sprite(e.get('id', 'page'), None, 0, 0, times[0], 'none', 0, order=58)
    sp.dynamic = dyn
    self.add(sp)
    for k in range(0, len(flat), 3):
        self.sound('key', times[k])
