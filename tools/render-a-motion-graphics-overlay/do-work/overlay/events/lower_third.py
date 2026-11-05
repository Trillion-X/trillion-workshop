"""lower-third: a name with a one-line description, in the clean over-footage type (white SF Pro Display for the name, SF Pro
Text for the line, soft wide drop shadow, no outline). The name slides in from the left on its word, a thin white rule draws
under it, the line lands on its own word, and the whole block slides back out to the left until it has left the frame.

Spec: {type: lowerthird, id, pos: [x, y], name: {text, at, size}, line: {text, at, size}, out}"""
from PIL import Image
from overlay import kit, look, stage
from overlay.helpers import marker_and_slide as L


def ev_lowerthird(self, e):
    fn, fl = kit.sf('display_bold', e['name'].get('size', 68)), kit.sf('text_semibold', e['line'].get('size', 34))
    name_im, pn = kit.text_img(e['name']['text'], fn, L.col('white'), shadow=True)
    line_im, pl = kit.text_img(e['line']['text'], fl, L.col('white'), shadow=True)
    x, y = e['pos']
    t_name, t_line, t_out = self.T(e['name']['at']), self.T(e['line']['at']), self.T(e['out'])
    gap = int(fn.size * 0.22)
    rule_y = y + name_im.height - 2 * pn + gap
    line_y = rule_y + gap
    rule_w = int(max(name_im.width - 2 * pn, line_im.width - 2 * pl) * 0.38)
    rule = Image.new('RGBA', (rule_w, 4), (255, 255, 255, 255))
    rule, pr = L.shadow(rule, look.LOOK['text_shadow'])
    self.safe_box(e.get('id', 'lt') + '-name', x, y, x + name_im.width - 2 * pn, rule_y + 4, t_name, t_out)
    self.safe_box(e.get('id', 'lt') + '-line', x, line_y, x + line_im.width - 2 * pl, line_y + line_im.height - 2 * pl, t_line, t_out)
    span = x + max(name_im.width, line_im.width) + 60

    def slide(tt, t_in):
        dx = -(1 - L.ease_out((tt - t_in) / 0.38)) * span if tt < t_in + 0.38 else 0.0
        if tt >= t_out:
            v = L.ease_in((tt - t_out) / 0.36)
            if v >= 1:
                return None
            dx -= v * span
        return dx
    parts = [('name', name_im, pn, y, t_name), ('line', line_im, pl, line_y, t_line)]
    for k, im, p, yy, t_in in parts:
        def dyn(tt, im=im, p=p, yy=yy, t_in=t_in):
            dx = slide(tt, t_in)
            return (None, 0, 0) if dx is None else (im, x - p + dx, yy - p)
        sp = stage.Sprite(f"{e.get('id', 'lt')}-{k}", None, 0, 0, t_in, 'none', 0, order=60, jitter=False)
        sp.dynamic = dyn
        self.add(sp)
        self.sound('word_in', t_in)

    def dyn_rule(tt):
        u = L.ease_out((tt - t_name - 0.2) / 0.4) if tt >= t_name + 0.2 else 0.0
        dx = slide(tt, t_name)
        if dx is None or u <= 0:
            return None, 0, 0
        r = rule.crop((0, 0, max(1, int(pr + rule_w * u)), rule.height))
        return r, x - pr + dx, rule_y - pr
    sp = stage.Sprite(e.get('id', 'lt') + '-rule', None, 0, 0, t_name, 'none', 0, order=60, jitter=False)
    sp.dynamic = dyn_rule
    self.add(sp)
    self.sound('word_out', t_out)
