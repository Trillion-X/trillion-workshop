"""The Build: one spec's events turned into sprites and sounds, and any frame of the overlay drawn from them.

Every event type is a module in events/ that defines ev_<type>(self, e); events.bind() puts each on Build, so a spec event
{"type": "<type>", ...} reaches it. Times in a spec are seconds from the overlay's first frame, or [word, offset] against
the voice's word times."""
import json
import math
import os
import subprocess
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from overlay import kit, look, stage

CRUMPLE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'crumple_a_card.py')


class Build:
    def __init__(self, spec):
        self.shot = spec
        self.id = spec['id']
        self.words = stage.Words(spec.get('voice'))
        self.sprites, self.sounds, self.log = [], [], []
        self.paper, self.exit_t, self.seed = None, None, 1
        self.t_exact = 0.0
        self.extra_sounds = {}  # kind -> [{file, gain_db}] made while building (count rolls)
        self.boxes = []  # (id, t0, t1, x0, y0, x1, y1) placed boxes, checked against the title-safe area after build

    def T(self, spec):
        return self.words.at(spec)

    def sound(self, kind, t):
        self.sounds.append((kind, t))

    def add(self, sp):
        self.sprites.append(sp)
        self.log.append({'id': sp.id, 'at': round(sp.t_in, 3)})
        return sp

    def byid(self, sid):
        return [s for s in self.sprites if s.id == sid]

    def sticker(self, rgb_img, mask, seed):
        """Pencil-restyled real pixels + cream sticker outline, RGBA PIL."""
        drawn = stage.pencil(rgb_img, look.R['cutout']['pencil'], seed=seed)
        a = cv2.GaussianBlur(mask, (0, 0), 0.8)
        o = int(look.R['cutout']['outline_px'] * stage.K)
        ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * o + 1, 2 * o + 1))
        outline = cv2.dilate((mask > 110).astype(np.uint8) * 255, ker)
        outline = cv2.GaussianBlur(outline, (0, 0), 1.2)
        h, w = mask.shape
        base = np.zeros((h, w, 4), np.uint8)
        base[..., :3] = stage.rgb('sticker_outline'); base[..., 3] = outline
        out = Image.fromarray(base, 'RGBA')
        out = stage.apply_texture(out, 'sheet', seed, 0.4)
        fg = np.dstack([drawn, a])
        out.alpha_composite(Image.fromarray(fg, 'RGBA'))
        return out

    def type_on_img(self, text, fnt, colour, n_chars, tracking_px=0.0):
        """Text image with the first n_chars visible; per-glyph advance for tracking."""
        asc, desc = fnt.getmetrics()
        width = int(sum(fnt.getlength(ch) + tracking_px for ch in text) + asc)
        img = Image.new('RGBA', (max(width, 4), int(asc + desc + 8)), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        x = 0.0
        for ch in text[:n_chars]:
            d.text((x, 4), ch, font=fnt, fill=colour + (255,))
            x += fnt.getlength(ch) + tracking_px
        return img

    def arrow_img(self, frm, to, bend, frac, colour, stroke):
        (x0, y0), (x1, y1) = [(a * stage.K, b * stage.K) for a, b in (frm, to)]
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        nx, ny = -(y1 - y0), (x1 - x0)
        ln = math.hypot(nx, ny) or 1
        cx, cy = mx + nx / ln * bend * stage.K, my + ny / ln * bend * stage.K
        ts = np.linspace(0, 1, 40)
        rng = np.random.default_rng(3)
        pts = [((1 - u) ** 2 * x0 + 2 * (1 - u) * u * cx + u * u * x1 + rng.normal(0, 0.6 * stage.K),
                (1 - u) ** 2 * y0 + 2 * (1 - u) * u * cy + u * u * y1 + rng.normal(0, 0.6 * stage.K)) for u in ts]
        n = int(len(pts) * min(frac, 1.0))
        img = Image.new('RGBA', (stage.W, stage.H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        sw = int(stroke * stage.K)
        if n >= 2:
            d.line(pts[:n], fill=colour + (255,), width=sw, joint='curve')
        if frac >= 1.0:
            ang = math.atan2(y1 - pts[-4][1], x1 - pts[-4][0])
            hl = 16 * stage.K
            for s in (-1, 1):
                a = ang + math.pi + s * 0.5
                d.line([(x1, y1), (x1 + hl * math.cos(a), y1 + hl * math.sin(a))], fill=colour + (255,), width=sw)
        bb = img.getbbox()
        if not bb:
            return None, 0, 0
        return img.crop(bb), bb[0], bb[1]

    def paper_text_img(self, text, size, paper, seed, fnt_spec=None, colour='ink'):
        fnt = stage.font(fnt_spec or look.R['fonts']['typewriter'], size * stage.K)
        lines = text.split('\n')
        lh = fnt.getbbox('Hg')[3] * 1.15
        tw = max(fnt.getlength(l) for l in lines)
        pad = look.R['scrap']['pad_px'] * stage.K
        w, h = int(tw + pad * 2), int(lh * len(lines) + pad * 1.6)
        img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        fill = stage.rgb('paper_white') if paper in ('crumpled', 'sheet') else stage.rgb('kraft')
        d.polygon(stage.torn_polygon(w, h, look.R['scrap']['torn_amp_px'] * stage.K, seed, step=9 * stage.K), fill=fill + (255,))
        for i, l in enumerate(lines):
            d.text((pad, pad * 0.8 + i * lh), l, font=fnt, fill=stage.rgb(colour) + (255,))
        return stage.apply_texture(img, paper if paper in look.R['textures'] else 'sheet', seed)

    # ---------- question card ----------
    def card_img(self, text, size, seed, typed=None):
        """Torn white paper with typewriter text; typed = number of words visible on the LAST block (None = all)."""
        return self.paper_text_img(text, size, 'crumpled', seed)

    def paper_ball(self, d, seed):
        """A crumpled paper ball, d px across: white paper texture, creased facets, soft shadow."""
        rng = np.random.default_rng(seed + 5)
        n = 26
        ang = np.sort(rng.uniform(0, 2 * math.pi, n))
        r = d / 2 * rng.uniform(0.82, 1.0, n)
        pts = [(d / 2 + r[i] * math.cos(ang[i]) + 6, d / 2 + r[i] * math.sin(ang[i]) + 6) for i in range(n)]
        im = Image.new('RGBA', (d + 12, d + 12), (0, 0, 0, 0))
        dr = ImageDraw.Draw(im)
        dr.polygon(pts, fill=stage.rgb('paper_white') + (255,))
        for _ in range(16):
            a1, a2 = rng.uniform(0, 2 * math.pi, 2)
            p1 = (d / 2 + 6 + d * 0.42 * math.cos(a1), d / 2 + 6 + d * 0.42 * math.sin(a1))
            p2 = (d / 2 + 6 + d * 0.2 * math.cos(a2), d / 2 + 6 + d * 0.2 * math.sin(a2))
            dr.line([p1, p2], fill=(205, 200, 190, 255), width=max(1, d // 60))
        im = stage.apply_texture(im, 'crumpled', seed, 0.9)
        shade = Image.new('L', im.size, 0)
        ImageDraw.Draw(shade).ellipse([d * 0.35, d * 0.35, d + 12, d + 12], fill=70)
        shade = shade.filter(ImageFilter.GaussianBlur(d / 6))
        dark = Image.new('RGBA', im.size, (60, 55, 45, 0))
        dark.putalpha(Image.fromarray(np.minimum(np.asarray(shade), np.asarray(im.getchannel('A')))))
        im.alpha_composite(dark)
        im, _ = stage.shadowed(im, {'dx': 4, 'dy': 8, 'blur': 10, 'opacity': 0.4})
        return im

    def collage_piece(self, shape_mask, kind, seed, photo=None):
        """The collage papers (_collage_paper) plus two that read clearly different from them at tick size: black paper and blue
        graph paper (intentional-variety: every piece of a set visibly different, none the odd one out)."""
        if kind not in ('black', 'blue_graph'):
            return self._collage_paper(shape_mask, kind, seed, photo)
        import cv2
        w, h = shape_mask.size
        base = Image.new('RGBA', (w, h), ((30, 29, 27) if kind == 'black' else (168, 196, 226)) + (255,))
        if kind == 'blue_graph':
            d = ImageDraw.Draw(base)
            for x in range(0, w, 9):
                d.line([(x, 0), (x, h)], fill=(250, 252, 255, 255), width=1)
            for y in range(0, h, 9):
                d.line([(0, y), (w, y)], fill=(250, 252, 255, 255), width=1)
        base = stage.apply_texture(base, 'crumpled', seed, 0.5)
        m = np.asarray(shape_mask).astype(np.uint8)
        edge = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
        out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        white = Image.new('RGBA', (w, h), (252, 251, 246, 255))
        white.putalpha(Image.fromarray(edge))
        out.alpha_composite(white)
        base.putalpha(Image.fromarray(m))
        out.alpha_composite(base)
        out, _ = stage.shadowed(out, {'dx': 2, 'dy': 5, 'blur': 9, 'opacity': 0.32})
        return out

    def _collage_paper(self, shape_mask, kind, seed, photo=None):
        """Fill a mask (L image) with a paper: newsprint with fake column text, kraft, graph paper, red paper, a piece
        of a real photo, ruled notebook paper, cardboard. Torn white edge + soft shadow."""
        import cv2
        w, h = shape_mask.size
        rng = np.random.default_rng(seed)
        base = Image.new('RGBA', (w, h), (0, 0, 0, 255))
        d = ImageDraw.Draw(base)
        if kind == 'newsprint':
            base.paste((228, 224, 214, 255), (0, 0, w, h))
            for y in range(4, h, 7):
                x = 3
                while x < w:
                    L = int(rng.integers(6, 22))
                    d.line([(x, y), (min(w, x + L), y)], fill=(70, 68, 64, 255), width=2)
                    x += L + 4
            base = stage.apply_texture(base, 'newsprint', seed, 0.5)
        elif kind == 'kraft':
            base.paste(stage.rgb('kraft') + (255,), (0, 0, w, h))
            base = stage.apply_texture(base, 'kraft', seed, 0.7)
        elif kind == 'graph':
            base.paste((246, 247, 242, 255), (0, 0, w, h))
            for x in range(0, w, 9):
                d.line([(x, 0), (x, h)], fill=kit.col('grid') + (255,), width=1)
            for y in range(0, h, 9):
                d.line([(0, y), (w, y)], fill=kit.col('grid') + (255,), width=1)
            base = stage.apply_texture(base, 'sheet', seed, 0.3)
        elif kind == 'red':
            base.paste(kit.col('accent_red') + (255,), (0, 0, w, h))
            base = stage.apply_texture(base, 'crumpled', seed, 0.6)
        elif kind == 'photo' and photo is not None:
            base.paste(kit.cover(photo, w, h, (rng.uniform(0.3, 0.7), rng.uniform(0.3, 0.7))).convert('RGBA'), (0, 0))
        elif kind == 'ruled':
            base.paste((250, 250, 244, 255), (0, 0, w, h))
            for y in range(6, h, 11):
                d.line([(0, y), (w, y)], fill=(150, 175, 205, 255), width=1)
            d.line([(int(w * 0.18), 0), (int(w * 0.18), h)], fill=(214, 120, 120, 255), width=1)
            base = stage.apply_texture(base, 'sheet', seed, 0.3)
        else:
            base.paste((186, 150, 104, 255), (0, 0, w, h))
            base = stage.apply_texture(base, 'kraft', seed + 3, 0.9)
        m = np.asarray(shape_mask).astype(np.uint8)
        edge = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
        out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        white = Image.new('RGBA', (w, h), (252, 251, 246, 255))
        white.putalpha(Image.fromarray(edge))
        out.alpha_composite(white)
        base.putalpha(Image.fromarray(m))
        out.alpha_composite(base)
        out, _ = stage.shadowed(out, {'dx': 2, 'dy': 5, 'blur': 9, 'opacity': 0.32})
        return out

    def build(self):
        for e in self.shot['events']:
            getattr(self, 'ev_' + e['type'])(e)
        self.duration = self.shot['duration_s']
        self.n_frames = int(math.ceil(self.duration * stage.FPS))
        if self.exit_t is None:
            self.exit_t = 1e9
        if self.words.w and self.shot.get('subtitles', True):
            self.subtitles()
        else:
            self.subs = []
        self.leak = self.make_leak()
        self.sprites.sort(key=lambda s: s.order)

    def subtitles(self):
        st = look.R['subtitles']
        fs = look.R['fonts']['subtitle']
        fnt = stage.font(fs, fs['size_px'] * stage.K)
        groups, cur = [], []
        for w in self.words.w:
            cur.append(w)
            if len(cur) >= st['max_words'] or w['text'][-1] in '.,?!:;':
                groups.append(cur); cur = []
        if cur:
            groups.append(cur)
        t0 = self.words.t0
        self.subs = []
        for i, g in enumerate(groups):
            text = ' '.join(x['text'] for x in g)
            a = t0 + g[0]['start']
            b = t0 + (groups[i + 1][0]['start'] if i + 1 < len(groups) else g[-1]['end'] + 0.25)
            asc, desc = fnt.getmetrics()
            e = int(fs['edge_px'] * stage.K)
            img = Image.new('RGBA', (int(fnt.getlength(text) + 4 * e), asc + desc + 4 * e), (0, 0, 0, 0))
            ImageDraw.Draw(img).text((2 * e, 2 * e), text, font=fnt, fill=stage.rgb('subtitle') + (255,), stroke_width=e, stroke_fill=stage.rgb('subtitle_edge') + (255,))
            self.subs.append((a, b, img))

    def make_leak(self):
        cols = [stage.rgb(c) for c in stage.PAL['light_leak']]
        yy, xx = np.mgrid[0:stage.H // 4, 0:stage.W // 4].astype(np.float32)
        g1 = np.exp(-(((xx - stage.W / 4 * 0.85) / (stage.W / 4 * 0.35)) ** 2 + ((yy - stage.H / 4 * 0.2) / (stage.H / 4 * 0.6)) ** 2))
        g2 = np.exp(-(((xx - stage.W / 4 * 0.2) / (stage.W / 4 * 0.4)) ** 2 + ((yy - stage.H / 4 * 0.9) / (stage.H / 4 * 0.5)) ** 2))
        a = np.clip(g1 + g2 * 0.8, 0, 1)
        col = (np.array(cols[0])[None, None] * g1[..., None] + np.array(cols[1])[None, None] * g2[..., None]) / np.maximum(g1 + g2, 1e-3)[..., None]
        im = np.dstack([col, a * 255]).astype(np.uint8)
        return Image.fromarray(im, 'RGBA').resize((stage.W, stage.H), Image.BILINEAR)

    def frame(self, n):
        self.t_exact = n / stage.FPS
        return self._torn_frame(n)

    def _torn_frame(self, n):
        tq = (n // stage.HOLD) * stage.HOLD / stage.FPS
        sheet = self.paper
        if sheet is not None and getattr(sheet, 'tear', None) and tq >= sheet.tear[0]:
            if not getattr(sheet, 'halves', None):
                img, x, y = sheet.dynamic(sheet.tear[0] + 1.0)
                h = img.height
                split = sheet.tear[1] - x
                rng = np.random.default_rng(77)
                pts_r = [(split + rng.uniform(-28, 28), yy) for yy in np.arange(0, h + 14, 14)]
                mL = Image.new('L', img.size, 0)
                ImageDraw.Draw(mL).polygon([(0, 0)] + pts_r + [(0, h)], fill=255)
                mR = Image.fromarray(255 - np.asarray(mL))
                L = img.copy(); L.putalpha(Image.fromarray(np.minimum(np.asarray(img.getchannel('A')), np.asarray(mL))))
                Rr = img.copy(); Rr.putalpha(Image.fromarray(np.minimum(np.asarray(img.getchannel('A')), np.asarray(mR))))
                sheet.halves = (L, Rr, x, y)
            L, Rr, x, y = sheet.halves
            part = sheet.tear[2]
            v = stage.ease_in((tq - sheet.tear[0]) / part['s'])

            def dyn_split(tt, L=L, Rr=Rr, x=x, y=y, v=v, part=part):
                c = Image.new('RGBA', (stage.W, stage.H), (0, 0, 0, 0))
                stage.paste(c, L.rotate(-12 * v, expand=False, resample=Image.BICUBIC), x - part['half_dx'] * v, y + part['half_dy'] * v)
                stage.paste(c, Rr.rotate(12 * v, expand=False, resample=Image.BICUBIC), x + part['half_dx'] * v, y + part['half_dy'] * v)
                return c, 0, 0
            sheet.dynamic = dyn_split if v < 1 else (lambda tt: (None, 0, 0))
        canvas = self._frame_with_person(n)
        return canvas

    def _frame_with_person(self, n):
        canvas = self._frame_layers(n)
        person = getattr(self, 'person', None)
        if person:
            f = os.path.join(person, 'frames', f'{n:05d}.png')
            m = os.path.join(person, 'mattes', f'{n:05d}.png')
            if os.path.exists(f) and canvas.getbbox():
                im = Image.open(f).convert('RGBA')
                im.putalpha(Image.open(m).convert('L'))
                # person above the big word only: everything at order > 5 stays on top
                under = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
                over = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
                tq = (n // stage.HOLD) * stage.HOLD / stage.FPS
                for i, sp in enumerate(self.sprites):
                    st = sp.state(tq)
                    if st is not None:
                        stage.render_sprite(under if sp.order <= 5 else over, st, (0, 0))
                if under.getbbox():
                    under.alpha_composite(im)
                    under.alpha_composite(over)
                    canvas = under
        return canvas

    def _frame_layers(self, n):
        tq = (n // stage.HOLD) * stage.HOLD / stage.FPS
        canvas = Image.new('RGBA', (stage.W, stage.H), (0, 0, 0, 0))
        jr = look.R['motion']['jitter_px'] * stage.K
        step = n // stage.HOLD
        for i, sp in enumerate(self.sprites):
            st = sp.state(tq)
            if st is None:
                continue
            jit = (0, 0)
            if sp.jitter and tq < getattr(sp, 'jitter_until', float('inf')):  # jitter_until: shake only while it settles in
                r = np.random.default_rng(step * 1000 + i)
                jit = (r.uniform(-jr, jr), r.uniform(-jr, jr))
            if getattr(sp, 'drift', None):  # slow wide drift for the whole time on screen: (px, period_s), 0 at landing
                px, period = sp.drift
                u = 2 * math.pi * max(0.0, tq - sp.t_in) / period
                jit = (jit[0] + px * stage.K * math.sin(u), jit[1] + 0.6 * px * stage.K * math.sin(0.7 * u))
            stage.render_sprite(canvas, st, jit)
        for a, b, img in self.subs:
            if a <= tq < b:
                stage.paste(canvas, img, stage.W / 2 - img.width / 2, stage.H * look.R['subtitles']['y_frac'] - img.height / 2)
        lk = look.R['exit']
        u = (tq - self.exit_t) / lk['leak_s']
        if 0 <= u <= 1:
            alpha = lk['leak_peak_alpha'] * math.sin(math.pi * u)
            stage.paste(canvas, self.leak, 0, 0, alpha)
        return canvas

    def safe_box(self, sid, x0, y0, x1, y1, t0=0.0, t1=1e9):
        self.boxes.append((sid, t0, t1, x0, y0, x1, y1))
        if x0 < kit.SAFE or y0 < kit.SAFE or x1 > stage.W - kit.SAFE or y1 > stage.H - kit.SAFE:
            raise SystemExit(f'{self.id}: {sid} at [{x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}] leaves the title-safe area ({kit.SAFE}px margin)')

    @staticmethod
    def opaque_box(im, x, y):
        bb = im.getchannel('A').point(lambda v: 255 if v > 200 else 0).getbbox()
        return (x + bb[0], y + bb[1], x + bb[2], y + bb[3]) if bb else (x, y, x, y)

    def crumple_frames(self, flat, rot, seed, seconds):
        """Run crumple_a_card.py on the card face; return ([(frame rotated + shadowed, pad)], meta). Frame 0 is the
        flat card, so the change from card to crumple has no jump."""
        out = look.out_path('crumple')
        os.makedirs(out, exist_ok=True)
        card = os.path.join(out, 'card.png')
        flat.save(card)
        done = subprocess.run([sys.executable, CRUMPLE, '--card', card, '--out', out, '--seconds', str(seconds),
                               '--fps', str(stage.FPS), '--seed', str(seed)], capture_output=True, text=True)
        if done.returncode:
            raise SystemExit(f'{self.id}: the crumple exit needs Blender (on the PATH, or named by BLENDER) and it failed: '
                             f'{(done.stderr or done.stdout).strip()[-300:]}; install Blender or give the card another exit')
        meta = json.load(open(os.path.join(out, 'crumple.json')))
        frames = []
        for i in range(meta['frames']):
            fr = Image.open(os.path.join(out, '%04d.png' % i)).convert('RGBA')
            frames.append(stage.shadowed(fr.rotate(-rot, expand=True, resample=Image.BICUBIC), look.R['card']['shadow']))
        return frames, meta

    def paper_motion(self, sp, e, t):
        """How a paper piece moves once it has landed, as data on its event: jitter_s shakes it (the recipe's jitter_px, on
        twos) only for its first jitter_s seconds; drift {px, period_s} moves it slowly and widely for its whole time on
        screen (movement-slow-and-small), starting from its landing place. A drift period varies by up to +-15% per piece
        (seeded by its id) so the pieces never move in step."""
        if e.get('jitter_s'):
            sp.jitter_until = t + e['jitter_s']
        if e.get('drift'):
            k = (sum(map(ord, sp.id)) % 31) / 30.0
            sp.drift = (e['drift']['px'], e['drift']['period_s'] * (0.85 + 0.3 * k))

    def roll_sound(self, kind, v_at, t0, t1, value, e):
        """One rolling sound that follows the count: a real keystroke every time the number passes a step, so the clicks race
        at the start and slow onto the final value, the last click on the value."""
        S = look.LOOK3['roll']
        step = max(1.0, value / (S['max_clicks_per_s'] * (t1 - t0)))
        times, last, tt = [], 0.0, t0
        while tt <= t1:
            v = v_at(tt)
            if math.floor(v / step) > math.floor(last / step) and (not times or tt - times[-1] >= 1 / S['max_clicks_per_s']):
                times.append(tt)
                last = v
            tt += 0.002
        if not times or abs(times[-1] - t1) > 0.02:
            times.append(t1)
        return self.clicks_sound(kind, t0, times, S['gain_db'], S['last_boost_db'])

    def clicks_sound(self, kind, t0, times, gain_db, last_boost_db=0.0):
        """One real keystroke (CC0, oga-keyboard-typing, LOOK3 roll.keys) at each time, mixed into <kind>.wav in the render's folder
        starting at t0: the count roll and the per-character typing of a type-on line (sound-synced-per-event)."""
        import wave
        S = look.LOOK3['roll']

        def read16(f):  # the keystroke files are 16-bit PCM WAV
            with wave.open(f) as w:
                y = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
                return y.reshape(-1, w.getnchannels()), w.getframerate()
        keys = [read16(look.asset(f)) for f in S['keys']]
        sr = 48000
        n = int((times[-1] - t0 + 0.6) * sr)
        out = np.zeros((n, 2), np.float32)
        rng = np.random.default_rng(7)
        for i, tt in enumerate(times):
            y, ksr = keys[int(rng.integers(len(keys)))]
            if ksr != sr:
                idx = np.arange(0, len(y), ksr / sr)
                y = np.stack([np.interp(idx, np.arange(len(y)), y[:, c]) for c in range(y.shape[1])], 1)
            if y.shape[1] == 1:
                y = np.repeat(y, 2, 1)
            y = y[:int(S['click_max_s'] * sr)] * 10 ** ((gain_db + rng.uniform(-2, 2) + (last_boost_db if i == len(times) - 1 else 0)) / 20)
            a = int((tt - t0) * sr)
            m = min(len(y), n - a)
            out[a:a + m] += y[:m]
        path = look.out_path(kind + '.wav')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with wave.open(path, 'wb') as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((np.clip(out, -1, 1) * 32767).astype(np.int16).tobytes())
        return path

    def chart_icon(self, spec, px):
        """A picture for one chart item, about px tall: a cut-out photo (file), or drawn: flame, molecule, tiles, price."""
        kind = spec['kind']
        if kind == 'photo':  # fits inside px * 1.5 wide by px tall
            im = Image.open(spec['file']).convert('RGBA')
            im = im.crop(im.getchannel('A').getbbox())
            s = min(px * 1.5 / im.width, px / im.height) * spec.get('scale', 1.0)
            im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
            im, _ = stage.shadowed(im, {'dx': 2, 'dy': 4, 'blur': 6, 'opacity': 0.35})
            return im
        ink = kit.col('ink') + (255,)
        if kind == 'price':  # one green dollar sign, then grey ones, as Apple Maps marks a low price
            fnt = kit.face(spec['font'], int(px * 0.9))
            signs = spec['signs']
            w = int(sum(fnt.getlength('$') for _ in range(signs)) + 10)
            im = Image.new('RGBA', (w, px), (0, 0, 0, 0))
            dd = ImageDraw.Draw(im)
            x = 5
            for i in range(signs):
                dd.text((x, px / 2), '$', font=fnt, fill=(tuple(spec['on']) if i < spec['lit'] else tuple(spec['off'])) + (255,), anchor='lm')
                x += fnt.getlength('$')
            return im
        im = Image.new('RGBA', (int(px * 1.5), px), (0, 0, 0, 0))
        dd = ImageDraw.Draw(im)
        if kind == 'flame':
            w, h = im.size
            c = w / 2
            pts = [(c, 4), (c + px * 0.18, px * 0.3), (c + px * 0.32, px * 0.55), (c + px * 0.3, px * 0.78), (c, px - 4),
                   (c - px * 0.3, px * 0.78), (c - px * 0.32, px * 0.55), (c - px * 0.12, px * 0.42), (c - px * 0.05, px * 0.2)]
            dd.line(pts + [pts[0]], fill=ink, width=4, joint='curve')
            inner = [(c, px * 0.45), (c + px * 0.14, px * 0.68), (c, px * 0.86), (c - px * 0.14, px * 0.68)]
            dd.line(inner + [inner[0]], fill=ink, width=3, joint='curve')
        elif kind == 'molecule':  # the four fused rings every steroid hormone shares, drawn as a skeletal formula
            r = px * 0.17
            hexes = [(px * 0.25, px * 0.62), (px * 0.25 + r * 1.732, px * 0.62), (px * 0.25 + r * 1.732 * 1.5, px * 0.62 - r * 1.5)]

            def hexagon(cx_, cy_):
                return [(cx_ + r * math.cos(math.radians(30 + 60 * i)), cy_ + r * math.sin(math.radians(30 + 60 * i))) for i in range(6)]
            for hx, hy in hexes:
                pts = hexagon(hx, hy)
                dd.line(pts + [pts[0]], fill=ink, width=3)
            px5 = hexes[2][0] + r * 1.55
            py5 = hexes[2][1] + r * 0.1
            pts = [(px5 + r * 0.95 * math.cos(math.radians(-90 + 72 * i + 36)), py5 + r * 0.95 * math.sin(math.radians(-90 + 72 * i + 36))) for i in range(5)]
            dd.line(pts + [pts[0]], fill=ink, width=3)
            im = im.crop(im.getbbox())
        elif kind == 'tiles':  # a few periodic-table tiles
            fs, fsn = kit.face(spec['font'], int(px * 0.36)), kit.face(spec['font'], int(px * 0.18))
            tw = int(px * 0.56)
            im = Image.new('RGBA', (tw * len(spec['tiles']) + 8 * (len(spec['tiles']) - 1) + 8, tw + 8), (0, 0, 0, 0))
            dd = ImageDraw.Draw(im)
            for i, (num, sym) in enumerate(spec['tiles']):
                x = 4 + i * (tw + 8)
                y = 4 + (i % 2) * 0
                dd.rectangle([x, y, x + tw, y + tw], fill=(253, 252, 246, 255), outline=ink, width=3)
                dd.text((x + 6, y + 4), str(num), font=fsn, fill=ink)
                dd.text((x + tw / 2, y + tw * 0.62), sym, font=fs, fill=ink, anchor='mm')
        return im
