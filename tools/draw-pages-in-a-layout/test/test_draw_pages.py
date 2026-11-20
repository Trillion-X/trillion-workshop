"""The page drawer on made-up notes pages: two pages draw as 1080x1350 JPEGs, a loose line and an overfull page are refused,
the drawn words are only the judged words, and a missing Chromium is refused in words
(run: python3 test/test_draw_pages.py). Needs Pillow and a headless Chromium (CHROME, Playwright's cache, or PATH)."""
import html
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, '..', 'do-work', 'draw_pages.py')

spec = importlib.util.spec_from_file_location('draw_pages', TOOL)
draw_pages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(draw_pages)

try:
    from PIL import Image
    PILLOW = True
except ImportError:
    PILLOW = False

try:
    CHROMIUM = draw_pages.find_chromium()
except draw_pages.Refusal:
    CHROMIUM = None

# The example layout: the notes-page CSS, with the structural classes it styles. Its text is data; the tool adds none.
LAYOUT_CSS = """*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#fff;color:#141414;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}
.t{font-size:70px;line-height:1.16;font-weight:400;letter-spacing:-1px;margin-bottom:56px}
.t mark{background:#fff59a;padding:0 10px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
h2{font-size:43px;font-weight:700;margin:0 0 22px}
ul{margin:0 0 54px 34px}
li{font-size:35px;line-height:1.34;margin-bottom:14px;padding-left:8px}
.p{padding:100px 92px 0}"""

DECK = """PAGE 1
A player on how to *stay calm* & keep score
Breathe before the serve
- Count two breaths before each point
- Look at the strings, not the net
Keep the same routine
- Same ball bounce every time
PAGE 2
Reset between points
- Walk to the back line
- Say one word to yourself
"""


def run_tool(request):
    """Runs the tool on one request file; returns (exit status, the last stdout line parsed)."""
    work = tempfile.mkdtemp()
    try:
        path = os.path.join(work, 'request.json')
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(request, handle)
        run = subprocess.run([sys.executable, TOOL, path], capture_output=True, text=True, timeout=600)
        return run.returncode, json.loads(run.stdout.strip().splitlines()[-1]), run
    finally:
        shutil.rmtree(work, ignore_errors=True)


def request(pages, folder, css=LAYOUT_CSS, **layout):
    return {'pages': pages, 'folder': folder, 'layout': {'css': css, **layout}}


SKIP = (not PILLOW and 'needs Pillow: python3 -m pip install -U pillow') or (
    CHROMIUM is None and 'needs a headless Chromium: set CHROME or install chromium-headless-shell with Playwright') or None


@unittest.skipIf(SKIP, SKIP or '')
class Drawing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    def folder(self, name):
        return os.path.join(self.work, name)

    def test_two_pages_draw_two_jpegs_of_the_page_size(self):
        code, answer, run = run_tool(request(DECK, self.folder('deck')))
        self.assertEqual(code, 0, run.stderr)
        self.assertEqual(answer['pages'], 2)
        self.assertEqual(len(answer['files']), 2)
        for number, path in enumerate(answer['files'], 1):
            self.assertTrue(path.endswith(f'{number:02d}.jpg'), path)
            self.assertTrue(os.path.isabs(path))
            with Image.open(path) as image:
                self.assertEqual(image.format, 'JPEG')
                self.assertEqual(image.size, (1080, 1350))
            self.assertTrue(os.path.exists(os.path.join(self.folder('deck'), f'{number:02d}.html')))
            self.assertTrue(os.path.exists(os.path.join(self.folder('deck'), f'{number:02d}.png')))

    def test_a_line_that_is_not_title_heading_or_bullet_is_refused_by_name(self):
        pages = 'PAGE 1\nA player on how to *stay calm*\nHeading\nA loose sentence with no dash'
        code, answer, _ = run_tool(request(pages, self.folder('loose')))
        self.assertEqual(code, 1)
        self.assertIn('line 3 "Heading" is not a title, a heading or a bullet', answer['error'])
        self.assertFalse(os.path.exists(self.folder('loose')), 'no page is written when one is refused')

    def test_a_page_with_too_many_bullets_is_refused_as_running_past_the_page(self):
        bullets = '\n'.join(f'- Point {number} about keeping one steady routine in every game and every set' for number in range(40))
        code, answer, _ = run_tool(request(f'PAGE 1\nA long page\nMany points\n{bullets}', self.folder('long')))
        self.assertEqual(code, 1)
        self.assertRegex(answer['error'], r'^page 1 runs past the page by \d+ px; use fewer words$')
        self.assertFalse(os.path.exists(self.folder('long')))

    def test_the_drawn_words_are_only_the_judged_words(self):
        code, _, run = run_tool(request(DECK, self.folder('words')))
        self.assertEqual(code, 0, run.stderr)
        judged = set(re.findall(r'[a-z0-9]+', DECK.lower()))
        for number in (1, 2):
            with open(os.path.join(self.folder('words'), f'{number:02d}.html'), encoding='utf-8') as handle:
                markup = handle.read()
            body = re.sub(r'<style>.*?</style>', ' ', markup, flags=re.S)
            drawn = html.unescape(re.sub(r'<[^>]+>', ' ', body))
            words = set(re.findall(r'[a-z0-9]+', drawn.lower()))
            self.assertTrue(words, 'the page draws words')
            self.assertEqual(words - judged, set(), f'page {number} draws words that were not judged')
        with open(os.path.join(self.folder('words'), '01.html'), encoding='utf-8') as handle:
            self.assertIn('<mark>stay calm</mark>', handle.read(), 'the starred title words are marked, the stars not drawn')

    def test_a_missing_chromium_is_refused_in_words(self):
        saved = os.environ.get('CHROME')
        os.environ['CHROME'] = os.path.join(self.work, 'no-such-browser')
        try:
            code, answer, _ = run_tool(request(DECK, self.folder('nobrowser')))
        finally:
            if saved is None:
                del os.environ['CHROME']
            else:
                os.environ['CHROME'] = saved
        self.assertEqual(code, 1)
        self.assertIn('CHROME is set to', answer['error'])


class Refusals(unittest.TestCase):
    def test_the_text_must_start_at_page_one(self):
        with self.assertRaisesRegex(draw_pages.Refusal, 'pages are numbered 1, 2, 3 in order'):
            draw_pages.parse_pages('PAGE 2\nTitle\n- a point')

    def test_page_one_needs_a_title_line(self):
        with self.assertRaisesRegex(draw_pages.Refusal, 'needs its title on the line right after PAGE 1'):
            draw_pages.parse_pages('PAGE 1\n- a point')

    def test_a_heading_with_no_bullet_under_it_is_refused(self):
        with self.assertRaisesRegex(draw_pages.Refusal, 'line 4 "Ending" is not a title, a heading or a bullet'):
            draw_pages.parse_pages('PAGE 1\nTitle\n- a point\nEnding')

    def test_the_layout_is_css_only(self):
        with self.assertRaisesRegex(draw_pages.Refusal, "holds '<'"):
            draw_pages.layout_of({'layout': {'css': '</style><b>x</b>'}})

    def test_title_marks_are_drawn_inside_mark_and_text_is_escaped(self):
        self.assertEqual(draw_pages.title_html('A <b>*big* & bold*'), 'A &lt;b&gt;<mark>big</mark> &amp; bold*')


if __name__ == '__main__':
    unittest.main()
