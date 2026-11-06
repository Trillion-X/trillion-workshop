"""Tests of make_contact_sheet.py on made-up pictures and a made-up ffmpeg test video (run: python3 test/test_make_contact_sheet.py)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, '..', 'do-work', 'make_contact_sheet.py')
HAVE_FFMPEG = shutil.which('ffmpeg') is not None


def run(req):
    r = subprocess.run([sys.executable, TOOL], input=json.dumps(req), capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout.strip().splitlines()[-1])


class Pictures(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.pics = []
        for i, (w, h, c) in enumerate([(800, 450, (200, 30, 30)), (600, 800, (30, 200, 30)), (800, 300, (30, 30, 200)), (640, 360, (220, 220, 20))]):
            p = os.path.join(self.d, f'p{i}.png')
            Image.new('RGB', (w, h), c).save(p)
            self.pics.append(p)

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_grid_size_and_cells_with_label_below(self):
        out = os.path.join(self.d, 's.jpg')
        code, ans = run({'kind': 'pictures', 'out': out, 'columns': 3, 'cell_width': 300, 'pictures': [{'path': p, 'label': f'n{i}'} for i, p in enumerate(self.pics)]})
        self.assertEqual(code, 0, ans)
        self.assertEqual(ans['result'], {'sheets': [out], 'tiles': 4})
        im = Image.open(out)
        lab = max(14, 300 // 22)
        self.assertEqual(im.size, (3 * 306 + 6, 2 * (168 + lab + 12) + 6))
        r, g, b = im.convert('RGB').getpixel((6 + 150, 6 + 80))
        self.assertTrue(r > 150 and g < 90, (r, g, b))  # the first picture fills its cell
        r, g, b = im.convert('RGB').getpixel((6 + 306 + 150, 6 + 80))
        self.assertTrue(g > 150 and r < 90, (r, g, b))  # the tall one is cut to its middle, still filling the cell

    def test_short_picture_leaves_the_background_under_it(self):
        out = os.path.join(self.d, 's.jpg')
        code, ans = run({'kind': 'pictures', 'out': out, 'columns': 1, 'cell_width': 300, 'pictures': [self.pics[2]], 'background': [0, 0, 0]})
        self.assertEqual(code, 0, ans)
        self.assertLess(sum(Image.open(out).convert('RGB').getpixel((150, 6 + 160))), 60)  # 300x112 picture in a 300x168 cell

    def test_stretch_label_above_file_names(self):
        out = os.path.join(self.d, 's.jpg')
        code, ans = run({'kind': 'pictures', 'out': out, 'columns': 2, 'cell_width': 200, 'pictures': [{'path': p} for p in self.pics], 'pad': 0,
                         'cell_aspect': 'first', 'fit': 'stretch', 'label': {'where': 'above', 'text': 'file-name', 'colour': 'yellow'}, 'background': 'black'})
        self.assertEqual(code, 0, ans)
        self.assertEqual(Image.open(out).size, (400, 2 * (112 + 22)))

    def test_the_older_command_line_makes_the_same_sheet(self):
        a, b = os.path.join(self.d, 'a.jpg'), os.path.join(self.d, 'b.jpg')
        r = subprocess.run([sys.executable, TOOL, a, '2', '240'] + [f'n{i}|{p}' for i, p in enumerate(self.pics)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        run({'kind': 'pictures', 'out': b, 'columns': 2, 'cell_width': 240, 'pictures': [{'path': p, 'label': f'n{i}'} for i, p in enumerate(self.pics)]})
        self.assertEqual(open(a, 'rb').read(), open(b, 'rb').read())

    def test_refusals_say_what_to_change(self):
        code, ans = run({'kind': 'pictures', 'out': os.path.join(self.d, 's.jpg'), 'pictures': []})
        self.assertEqual(code, 1)
        self.assertIn('at least one picture', ans['error'])
        code, ans = run({'kind': 'pictures', 'out': 'x.jpg', 'pictures': ['/no/such.png']})
        self.assertIn('no picture at', ans['error'])
        code, ans = run({'kind': 'sheet'})
        self.assertIn('`kind`', ans['error'])
        code, ans = run({'kind': 'pictures', 'out': 'x.jpg', 'pictures': self.pics, 'fit': 'squash'})
        self.assertIn('fit is', ans['error'])


@unittest.skipUnless(HAVE_FFMPEG, 'needs ffmpeg')
class Frames(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        cls.video = os.path.join(cls.d, 'v.mp4')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6', '-pix_fmt', 'yuv420p', cls.video], check=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.d)

    def test_frames_at_times_three_to_a_row(self):
        out = os.path.join(self.d, 't.jpg')
        code, ans = run({'kind': 'frames-at-times', 'video': self.video, 'times': ['0.5', 1.5, '2.5', '3.5'], 'width': 320, 'out': out})
        self.assertEqual(code, 0, ans)
        self.assertEqual(Image.open(out).size, (3 * 320, 2 * 180))

    def test_every_splits_over_sheets(self):
        out = os.path.join(self.d, 'e-{k}.jpg')
        code, ans = run({'kind': 'frames-at-times', 'video': self.video, 'every': {'from': 1, 'to': 3.1, 'fps': 6}, 'width': 160, 'per_sheet': 12, 'out': out})
        self.assertEqual(code, 0, ans)
        self.assertEqual(ans['result']['tiles'], 13)
        self.assertEqual([os.path.basename(p) for p in ans['result']['sheets']], ['e-1.jpg', 'e-2.jpg'])
        self.assertEqual(Image.open(os.path.join(self.d, 'e-2.jpg')).size, (3 * 160, 90))

    def test_frames_at_times_older_command_line(self):
        out = os.path.join(self.d, 'old.jpg')
        r = subprocess.run([sys.executable, os.path.join(HERE, '..', 'do-work', 'frames_at_times.py'), out, self.video, '1', '2', '--width', '160'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(Image.open(out).size, (3 * 160, 90))

    def test_more_than_one_sheet_needs_k(self):
        code, ans = run({'kind': 'frames-at-times', 'video': self.video, 'times': ['1', '2'], 'per_sheet': 1, 'out': os.path.join(self.d, 'x.jpg')})
        self.assertEqual(code, 1)
        self.assertIn('{k}', ans['error'])

    def test_frames_at_a_rate_tiles(self):
        out = os.path.join(self.d, 'r-%02d.jpg')
        code, ans = run({'kind': 'frames-at-a-rate', 'video': self.video, 'fps': 2, 'width': 128, 'grid': [3, 2], 'out': out, 'label': {'stamp': 'frame'}})
        self.assertEqual(code, 0, ans)
        self.assertEqual(len(ans['result']['sheets']), 2)  # 12 frames, 6 a sheet
        self.assertEqual(Image.open(ans['result']['sheets'][0]).size, (3 * 128, 2 * 72))

    def test_frames_at_a_rate_first_sheet_of_a_stretch(self):
        out = os.path.join(self.d, 'w.jpg')
        code, ans = run({'kind': 'frames-at-a-rate', 'video': self.video, 'fps': 2, 'start': 1, 'end': 4, 'width': 128, 'grid': [2, 2], 'sheets': 1, 'out': out})
        self.assertEqual(code, 0, ans)
        self.assertEqual(ans['result'], {'sheets': [out], 'tiles_per_sheet': 4})

    def test_unknown_stamp_is_refused(self):
        code, ans = run({'kind': 'frames-at-a-rate', 'video': self.video, 'fps': 2, 'out': os.path.join(self.d, 'z.jpg'), 'label': {'stamp': 'date'}})
        self.assertEqual(code, 1)
        self.assertIn('label.stamp', ans['error'])


if __name__ == '__main__':
    unittest.main()
