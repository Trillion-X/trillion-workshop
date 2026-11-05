"""Every template on made-up frames and cut-outs, the settings row handed as a record, and the refusals
(run: python3 test/test_compose_thumbnails.py). Needs Pillow and any TrueType font on the computer (DejaVu, Liberation or Arial)."""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

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


@unittest.skipUnless(FONTS, 'needs a TrueType font (DejaVu, Liberation or Arial)')
class Templates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        os.makedirs(os.path.join(cls.d, 'frames')); os.makedirs(os.path.join(cls.d, 'cut'))
        for i, n in enumerate(('one', 'two')):
            im = Image.new('RGB', (3840, 2160), (60 + 80 * i, 90, 140 - 40 * i))
            ImageDraw.Draw(im).ellipse((1400, 400, 2100, 1300), fill=(220, 180, 150))
            im.save(os.path.join(cls.d, 'frames', f'{n}.png'))
            cut = im.crop((1000, 150, 3000, 2160)).convert('RGBA')
            m = Image.new('L', cut.size, 0); ImageDraw.Draw(m).ellipse((400, 200, 1100, 1900), fill=255); cut.putalpha(m)
            cut.save(os.path.join(cls.d, 'cut', f'{n}_cut.png'))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.d)

    def run_tool(self, **over):
        req = {'frames': os.path.join(self.d, 'frames'), 'cutouts': os.path.join(self.d, 'cut'), 'out': os.path.join(self.d, 'out'),
               'font': {'file': FONTS[0], 'variable': False}, 'settings_record': record(CANDIDATES)}
        req.update(over)
        r = subprocess.run([sys.executable, TOOL], input=json.dumps(req), capture_output=True, text=True)
        return r.returncode, json.loads(r.stdout.strip().splitlines()[-1])

    def test_every_template_makes_a_1280_by_720_picture(self):
        code, ans = self.run_tool()
        self.assertEqual(code, 0, ans)
        self.assertEqual(len(ans['result']['thumbnails']), 6)
        for p in ans['result']['thumbnails']:
            self.assertEqual(Image.open(p).size, (1280, 720), p)

    def test_the_split_claim_has_its_white_split_and_red_box(self):
        code, ans = self.run_tool(only=['A'])
        im = Image.open(ans['result']['thumbnails'][0]).convert('RGB')
        self.assertEqual(im.getpixel((600, 10)), (255, 255, 255))
        self.assertEqual(im.getpixel((45, 525)), (214, 32, 39))

    def test_the_tags_backdrop_is_the_candidates_colour(self):
        code, ans = self.run_tool(only=['D'])
        r, g, b = Image.open(ans['result']['thumbnails'][0]).convert('RGB').getpixel((1270, 710))
        self.assertTrue(b > 180 and r < 80, (r, g, b))

    def test_request_settings_lay_over_the_row(self):
        code, ans = self.run_tool(only=['A'], settings={'candidates': {'A': dict(CANDIDATES['A'], text='OTHER WORDS')}})
        self.assertEqual(code, 0, ans)

    def test_refusals(self):
        code, ans = self.run_tool(only=['Z'])
        self.assertIn('no candidate Z', ans['error'])
        bad = dict(CANDIDATES['A']); del bad['arrow_to']
        code, ans = self.run_tool(settings_record=record({'A': bad}))
        self.assertIn('needs the value', ans['error'])
        code, ans = self.run_tool(settings_record=record({'A': dict(CANDIDATES['A'], person='nobody')}))
        self.assertIn('no frame nobody', ans['error'])
        code, ans = self.run_tool(settings_record='record:setting:compose-thumbnails-from-layout-templates~film~x')
        self.assertIn('run-with-settings', ans['error'])
        code, ans = self.run_tool(settings_record=None)
        self.assertIn('no candidates', ans['error'])
        code, ans = self.run_tool(font={'file': '/no/font.ttf'})
        self.assertIn('font.file', ans['error'])


if __name__ == '__main__':
    unittest.main()
