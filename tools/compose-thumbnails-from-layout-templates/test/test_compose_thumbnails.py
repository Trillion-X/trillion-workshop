"""Exercise the CLI with synthetic frames, cut-outs and scenes (run: python3 test/test_compose_thumbnails.py)."""
import glob
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, '..', 'do-work', 'compose_thumbnails.py')
FONTS = [f for p in ('/usr/share/fonts/**/DejaVuSans-Bold.ttf', '/usr/share/fonts/**/LiberationSans-Bold.ttf',
                     '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/Library/Fonts/Arial Bold.ttf') for f in glob.glob(p, recursive=True)]
FACE = [1500, 500, 500]
CANDIDATES = {
    'A': {'template': 'split_claim', 'person': 'one', 'face': FACE, 'subject_frame': 'two', 'subject': [1300, 1300, 900], 'text': 'BIG CLAIM', 'arrow_to': [900, 420]},
    'B': {'template': 'face_right_stack', 'person': 'one', 'face': FACE, 'face_px': 235, 'face_x': 920, 'face_y': 40, 'bg': 'two',
          'bg_box': [1500, 1200, 1900, 1070], 'lines': [['12G', 'plain', 210], ['FIBRE', 'box', 118]], 'text_y': 150},
    'C': {'template': 'zoom_flaw', 'person': 'one', 'face': FACE, 'face_px': 250, 'cut_x': 820, 'face_y': 70, 'bg': 'two', 'bg_box': [2000, 1000, 2600, 1460],
          'zoom_frame': 'two', 'zoom_c': [1490, 1420], 'zoom_r': 170, 'zoom_at': [250, 520], 'lines': ['TOO', 'DRY'], 'size': 142},
    'D': {'template': 'tags', 'person': 'one', 'face': FACE, 'face_px': 230, 'cut_x': 800, 'face_y': 40, 'backdrop': [28, 110, 220],
          'tags': [['300 CAL', 50, 120, 104, 8], ['12G', 90, 330, 150, -8]]},
    'E': {'template': 'hold_quote', 'person': 'one', 'face': FACE, 'face_px': 260, 'cut_x': 860, 'face_y': 60, 'bg': 'two', 'bg_box': [1900, 1100, 2800, 1575],
          'text': '"JUST OATS"', 'arrow_to': [520, 470]},
    'F': {'template': 'corner_face', 'person': 'one', 'face': FACE, 'face_px': 250, 'cut_x': 220, 'face_y': 360, 'bg': 'two', 'bg_box': [1400, 1250, 1500, 844],
          'lines': [['20G', 600], ['FIBRE?', 600]], 'text_y': 40, 'size': 138, 'arrow_from': [700, 360], 'arrow_to': [600, 500]},
}


def record(cands):
    return {'id': 'record:setting:compose-thumbnails-from-layout-templates~film~sample-film', 'type': 'record:setting',
            'value': {'name': 'sample', 'tool': 'tool:compose-thumbnails-from-layout-templates', 'scope_kind': 'film', 'scope_id': 'sample-film',
                      'settings': json.dumps({'candidates': cands}), 'from': 'made up', 'status': 'active'}}


def run_cli(req, request_file=None):
    cmd = [sys.executable, '-B', '-W', 'error', TOOL]
    raw = json.dumps(req)
    if request_file is not None:
        request_file.write_text(raw, encoding='utf-8')
        cmd.append(str(request_file))
        raw = None
    r = subprocess.run(cmd, input=raw, capture_output=True, text=True, timeout=30)
    if r.stderr:
        raise AssertionError(r.stderr)
    return r.returncode, json.loads(r.stdout)


def box(x=0, y=0, width=10, height=10):
    return dict(x=x, y=y, width=width, height=height)


def scene(*layers, width=96, height=72):
    return {'scene': dict(width=width, height=height, background='#101820', layers=list(layers))}


@unittest.skipUnless(FONTS, 'needs a TrueType font (DejaVu, Liberation or Arial)')
class Templates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        os.makedirs(os.path.join(cls.d, 'frames'))
        os.makedirs(os.path.join(cls.d, 'cut'))
        for i, n in enumerate(('one', 'two')):
            im = Image.new('RGB', (3840, 2160), (60 + 80 * i, 90, 140 - 40 * i))
            ImageDraw.Draw(im).ellipse((1400, 400, 2100, 1300), fill=(220, 180, 150))
            im.save(os.path.join(cls.d, 'frames', f'{n}.png'))
            cut = im.crop((1000, 150, 3000, 2160)).convert('RGBA')
            m = Image.new('L', cut.size, 0)
            ImageDraw.Draw(m).ellipse((400, 200, 1100, 1900), fill=255)
            cut.putalpha(m)
            cut.save(os.path.join(cls.d, 'cut', f'{n}_cut.png'))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.d)

    def run_tool(self, **over):
        req = {'frames': os.path.join(self.d, 'frames'), 'cutouts': os.path.join(self.d, 'cut'), 'out': os.path.join(self.d, 'out'),
               'font': {'file': FONTS[0], 'variable': False}, 'settings_record': record(CANDIDATES)}
        req.update(over)
        return run_cli(req)

    def test_every_template_makes_a_1280_by_720_picture(self):
        code, ans = self.run_tool()
        self.assertEqual(code, 0, ans)
        expected = [os.path.join(self.d, 'out', f'{cid}.png') for cid in CANDIDATES]
        self.assertEqual(ans, {'result': {'thumbnails': expected}})
        for p in expected:
            with Image.open(p) as im:
                self.assertEqual((im.mode, im.size), ('RGB', (1280, 720)), p)

        code, ans = self.run_tool(only=['banner', 'A'], settings={'candidates': {'banner': scene(width=37, height=9)}})
        self.assertEqual(code, 0, ans)
        banner = os.path.join(self.d, 'out', 'banner.png')
        self.assertEqual(ans, {'result': {'thumbnails': [banner, expected[0]]}})
        with Image.open(banner) as im:
            self.assertEqual(im.size, (37, 9))

    def test_the_split_claim_has_its_white_split_and_red_box(self):
        code, ans = self.run_tool(only=['A'])
        self.assertEqual(code, 0, ans)
        with Image.open(ans['result']['thumbnails'][0]) as im:
            self.assertEqual(im.getpixel((600, 10)), (255, 255, 255))
            self.assertEqual(im.getpixel((45, 525)), (214, 32, 39))

    def test_the_tags_backdrop_is_the_candidates_colour(self):
        code, ans = self.run_tool(only=['D'])
        self.assertEqual(code, 0, ans)
        with Image.open(ans['result']['thumbnails'][0]) as im:
            r, g, b = im.getpixel((1270, 710))
            self.assertTrue(b > 180 and r < 80, (r, g, b))

    def test_request_settings_lay_over_the_row(self):
        code, ans = self.run_tool(only=['A'], settings={'candidates': {'A': dict(CANDIDATES['A'], text='OTHER WORDS')}})
        self.assertEqual(code, 0, ans)

    def test_refusals(self):
        code, ans = self.run_tool(only=['Z'])
        self.assertIn('no candidate Z', ans['error'])
        bad = dict(CANDIDATES['A'])
        del bad['arrow_to']
        code, ans = self.run_tool(settings_record=record({'A': bad}))
        self.assertIn('needs the value', ans['error'])
        code, ans = self.run_tool(settings_record=record({'A': dict(CANDIDATES['A'], person='nobody')}))
        self.assertIn('no frame nobody', ans['error'])
        code, ans = self.run_tool(settings_record='record:setting:compose-thumbnails-from-layout-templates~film~x')
        self.assertIn('no rows were handed in', ans['error'])
        code, ans = self.run_tool(settings_record=None)
        self.assertIn('no candidates', ans['error'])
        code, ans = self.run_tool(font={'file': '/no/font.ttf'})
        self.assertIn('font.file', ans['error'])


class Scenes(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.frames = self.root / 'frames'
        self.frames.mkdir()
        self.out = self.root / 'out'

    def request(self, **candidates):
        return {'out': str(self.out), 'settings': {'candidates': candidates}}

    def refusal(self, candidate, message, cid='candidate', **inputs):
        code, answer = run_cli(self.request(**{cid: candidate}) | inputs)
        self.assertEqual(code, 1, answer)
        self.assertEqual(list(answer), ['error'])
        self.assertIn(message, answer['error'])
        self.assertFalse((self.out / 'candidate.png').exists())

    def test_arbitrary_canvas_sizes_via_request_file(self):
        sizes = {'vertical': (1080, 1920), 'landscape': (1200, 630), 'banner': (600, 180), 'odd': (17, 29)}
        req = self.request(**{cid: scene(width=w, height=h) for cid, (w, h) in sizes.items()})
        code, answer = run_cli(req, self.root / 'request.json')
        self.assertEqual(code, 0, answer)
        self.assertEqual(answer, {'result': {'thumbnails': [str(self.out / f'{cid}.png') for cid in sizes]}})
        for cid, size in sizes.items():
            with Image.open(self.out / f'{cid}.png') as im:
                self.assertEqual((im.mode, im.size, im.getpixel((0, 0))), ('RGB', size, (16, 24, 32)))

    @unittest.skipUnless(FONTS, 'needs a TrueType font (DejaVu, Liberation or Arial)')
    def test_cover_rect_and_fitted_text_paint_in_order(self):
        art = Image.new('RGBA', (24, 12), (240, 0, 0, 255))
        art.paste((0, 230, 0, 255), (6, 0, 18, 12))
        art.paste((0, 0, 240, 255), (18, 0, 24, 12))
        art.paste((0, 230, 0, 0), (8, 7, 16, 12))
        art.save(self.frames / 'frame one.png')
        candidate = scene(
            dict(type='image', frame='frame one', box=box(2, 2, 20, 40)),
            dict(type='rect', paint='#3850C0', box=box(12, 12, 56, 40)),
            dict(type='text', paint='#FFFFFF', box=box(20, 15, 40, 34), text='Café\nOpen', font_size=48, min_font_size=9),
        )
        code, answer = run_cli({'out': str(self.out), 'frames': str(self.frames), 'font': {'file': FONTS[0]},
                                'settings_record': record({'mixed': candidate})})
        self.assertEqual(code, 0, answer)
        with Image.open(answer['result']['thumbnails'][0]) as im:
            self.assertEqual(im.getpixel((10, 9)), (0, 230, 0))  # centered cover, not a stretch
            self.assertEqual(im.getpixel((10, 39)), (16, 24, 32))  # transparent source reveals background
            self.assertEqual(im.getpixel((12, 12)), (56, 80, 192))  # rect covers photo
            self.assertEqual(im.getpixel((67, 51)), (56, 80, 192))
            self.assertEqual(im.getpixel((68, 51)), (16, 24, 32))  # half-open bounds
            ink = [(x, y) for y in range(12, 52) for x in range(12, 68) if im.getpixel((x, y)) != (56, 80, 192)]
            self.assertTrue(ink)
            self.assertTrue(all(20 <= x < 60 and 15 <= y < 49 for x, y in ink))
            self.assertTrue(any(im.getpixel(p) == (255, 255, 255) for p in ink))

    def test_invalid_geometry_and_layer_types(self):
        rect = dict(type='rect', paint='#123456', box=box())
        cases = [
            (scene(width=True), 'canvas width'), (scene(height=0), 'canvas height'),
            (scene(width=4097), 'canvas width'), (scene(width=4096, height=4096), 'pixels'),
            (scene(rect | {'box': box(x=-1)}), 'box.x'), (scene(rect | {'box': box(y=2.5)}), 'box.y'),
            (scene(rect | {'box': box(x=95, width=2)}), 'box.width'),
            (scene(rect | {'box': box(y=71, height=2)}), 'box.height'),
            (scene(rect | {'box': box(width=0)}), 'box.width'),
            (scene(rect | {'paint': '#123'}), 'paint'), (scene(rect | {'type': []}), 'type must be'),
            (scene(rect | {'type': 'video'}), 'type must be'), (scene(rect | {'opacity': 1}), 'unknown fields'),
            (scene(*([rect] * 17)), 'at most 16 layers'), (scene() | {'template': 'tags'}, 'not both'),
        ]
        for candidate, message in cases:
            with self.subTest(candidate=candidate):
                self.refusal(candidate, message)
        code, answer = run_cli(self.request(**{f'card-{i}': scene() for i in range(17)}))
        self.assertEqual(code, 1, answer)
        self.assertIn('at most 16 scene candidates', answer['error'])

    def test_missing_wrong_format_animated_and_oversized_art(self):
        art = Image.new('RGB', (6, 7), 'red')
        art.save(self.frames / 'disguised.png', 'JPEG')
        art.save(self.frames / 'animated.png', save_all=True, append_images=[Image.new('RGB', art.size, 'blue')])
        Image.new('L', (4900, 4900)).save(self.frames / 'oversized.png')
        for name, message in [('absent', 'no frame absent'), ('disguised', 'still PNG'),
                              ('animated', 'still PNG'), ('oversized', 'exceeds 24000000 pixels')]:
            with self.subTest(name=name):
                self.refusal(scene(dict(type='image', frame=name, box=box())), message, frames=str(self.frames))
        self.refusal(scene(dict(type='image', frame='absent', box=box())), 'needs `frames`')

    def test_unsafe_names_and_links(self):
        for name in ('', '..', '../escape', '/absolute', 'sub\\escape', 'line\nbreak'):
            with self.subTest(name=name):
                self.refusal(scene(), 'safe file name', cid=name)
                self.refusal(scene(dict(type='image', frame=name, box=box())), 'safe file name', frames=str(self.frames))
        self.assertFalse((self.root / 'escape.png').exists())
        other = self.root / 'other.png'
        other.write_bytes(b'intact')
        (self.frames / 'linked.png').symlink_to(other)
        self.refusal(scene(dict(type='image', frame='linked', box=box())), 'points outside', frames=str(self.frames))
        self.out.mkdir(exist_ok=True)
        (self.out / 'linked.png').symlink_to(other)
        self.refusal(scene(), 'output must not be a link', cid='linked')
        self.assertEqual(other.read_bytes(), b'intact')

    def output_module(self):
        spec = importlib.util.spec_from_file_location('compose_thumbnails', TOOL)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_output_link_swapped_after_check_is_not_followed(self):
        self.out.mkdir()
        target = self.out / 'candidate.png'
        target.write_bytes(b'previous image')
        other = self.root / 'other.png'
        other.write_bytes(b'preserve source')
        module = self.output_module()
        lstat = module.os.lstat

        def swap(path, *args, **kwargs):
            found = lstat(path, *args, **kwargs)
            if str(path) == str(target):
                target.unlink()
                target.symlink_to(other)
            return found

        with patch.object(module.os, 'lstat', side_effect=swap):
            self.assertEqual(module.build('candidate', scene(), str(self.out)), str(target))
        self.assertFalse(target.is_symlink())
        self.assertEqual(other.read_bytes(), b'preserve source')
        with Image.open(target) as im:
            self.assertEqual((im.mode, im.size), ('RGB', (96, 72)))
        self.assertEqual(list(self.out.iterdir()), [target])

    def test_failed_save_preserves_previous_image_and_cleans_staging(self):
        self.out.mkdir()
        target = self.out / 'candidate.png'
        target.write_bytes(b'previous image')
        module = self.output_module()
        with patch.object(module.Image.Image, 'save', side_effect=OSError('synthetic write failure')):
            with self.assertRaisesRegex(OSError, 'synthetic write failure'):
                module.build('candidate', scene(), str(self.out))
        self.assertEqual(target.read_bytes(), b'previous image')
        self.assertEqual(list(self.out.iterdir()), [target])

    @unittest.skipUnless(FONTS, 'needs a TrueType font (DejaVu, Liberation or Arial)')
    def test_text_refusals_leave_no_image(self):
        text = dict(type='text', paint='#FFFFFF', box=box(), font_size=32, text='Ordinary words')
        for delta, message in [({}, 'does not fit'), ({'text': '𓀀'}, 'cannot render'), ({'text': ' '}, 'printable'),
                               ({'text': 'A' * 513}, 'printable'), ({'font_size': False}, 'font_size'),
                               ({'min_font_size': 33}, 'min_font_size'), ({'font_style': 'Bold'}, 'variable font')]:
            with self.subTest(delta=delta):
                self.refusal(scene(text | delta), message, font={'file': FONTS[0]})
        self.refusal(scene(text), 'font.file')
        not_a_font = self.root / 'not-a-font.ttf'
        not_a_font.write_text('not a font', encoding='utf-8')
        self.refusal(scene(text), 'cannot render text', font={'file': str(not_a_font)})


if __name__ == '__main__':
    unittest.main()
