#!/usr/bin/env python3
"""tools/render-a-motion-graphics-overlay on made-up specs and the made-up example look (read-data/example-look).

Run: python3 test/test_render_a_motion_graphics_overlay.py   (needs Pillow, numpy, OpenCV and ffmpeg)
Ported checks: the render lock (old test_rounds.py: reentrant for children and nested calls, excludes a stranger, nice 20,
waits while a flag file says so and gives up after max_s) and the still slide (old test_slide_card.py: a canvas spec renders
one PNG of that size, fit_with sets one size for a carousel, words that do not fit stop the render by name)."""
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.dirname(HERE)
DO_WORK = os.path.join(TOOL, 'do-work')
PROGRAM = os.path.join(DO_WORK, 'render_a_motion_graphics_overlay.py')
EXAMPLE = os.path.join(TOOL, 'read-data', 'example-look')
LOOK = json.load(open(os.path.join(EXAMPLE, 'look.json')))
sys.path.insert(0, DO_WORK)


def run(request):
    p = subprocess.run([sys.executable, PROGRAM], input=json.dumps(request), capture_output=True, text=True, timeout=600)
    last = p.stdout.strip().split('\n')[-1] if p.stdout.strip() else ''
    return p.returncode, (json.loads(last) if last.startswith('{') else None), p


def request(out, events, duration_s=2.0, canvas=(640, 360), **extra):
    spec = {'id': 'made-up', 'duration_s': duration_s, 'canvas': list(canvas), 'events': events, **extra.pop('spec_extra', {})}
    return {'settings': LOOK, 'spec': spec, 'assets': EXAMPLE, 'out': out, **extra}


STRIP = {'type': 'strip', 'id': 'line', 'text': 'made-up words', 'font': 'typewriter', 'size': 34, 'paper': 'white', 'pos': [160, 150], 'at': 0.2}


class Render(unittest.TestCase):
    def test_a_spec_renders_an_overlay_with_alpha_its_sound_and_timeline(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, p = run(request(out, [STRIP, {'type': 'exit', 'at': 1.2}]))
            self.assertEqual(code, 0, p.stderr[-800:])
            got = answer['result']
            self.assertEqual((got['id'], got['frames']), ('made-up', 48))
            probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height',
                                    '-of', 'json', got['overlay']], capture_output=True, text=True).stdout
            stream = json.loads(probe)['streams'][0]
            self.assertEqual((stream['codec_name'], stream['pix_fmt'], stream['width'], stream['height']), ('prores', 'yuva444p12le', 640, 360))
            timeline = json.load(open(got['timeline']))
            self.assertEqual([e['id'] for e in timeline['elements']], ['line'])
            self.assertIn('whoosh', [s['kind'] for s in timeline['sounds']])
            self.assertTrue(all(s['file'] == os.path.join(EXAMPLE, 'tick.wav') for s in timeline['sound_events']), 'sound files are read from assets')
            self.assertTrue(os.path.getsize(got['sound']) > 1000)

    def test_stills_draw_frames_over_the_spec_background(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, p = run(request(out, [STRIP, {'type': 'exit', 'at': 1.2}], stills=[0.1, 0.8], spec_extra={'still_bg': 'none'}))
            self.assertEqual(code, 0, p.stderr[-800:])
            first, second = [Image.open(s) for s in answer['result']['stills']]
            self.assertIsNone(first.getchannel('A').getbbox(), 'nothing is on the overlay before the strip lands')
            self.assertIsNotNone(second.getchannel('A').getbbox(), 'the strip is on the overlay once it has landed')

    def test_an_element_left_on_the_last_frame_stops_the_render_by_name(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, _ = run(request(out, [STRIP]))
            self.assertEqual(code, 1)
            self.assertIn('the last overlay frame still shows something', answer['error'])

    def test_an_element_outside_the_title_safe_area_stops_the_render(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, _ = run(request(out, [dict(STRIP, pos=[560, 150])]))
            self.assertEqual(code, 1)
            self.assertIn('leaves the title-safe area', answer['error'])

    def test_a_relative_spec_file_is_read_against_root(self):
        with tempfile.TemporaryDirectory() as out:
            Image.new('RGB', (640, 360), (10, 120, 200)).save(os.path.join(out, 'bg.png'))
            code, answer, p = run(request(out, [{'type': 'exit', 'at': 0.2}], stills=[0.0], root=out, spec_extra={'still_bg': 'bg.png', 'still_format': 'png'}))
            self.assertEqual(code, 0, p.stderr[-800:])
            px = Image.open(answer['result']['stills'][0]).convert('RGB').getpixel((5, 5))
            self.assertEqual(px, (10, 120, 200))


class Refusals(unittest.TestCase):
    def test_a_request_without_what_it_needs_is_refused_in_words(self):
        code, answer, _ = run({'spec': {'id': 'x', 'duration_s': 1, 'events': []}})
        self.assertEqual(code, 1)
        self.assertIn('lacks', answer['error'])

    def test_settings_without_the_look_are_refused(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, _ = run({'settings': {'frame': [640, 360]}, 'spec': {'id': 'x', 'duration_s': 1, 'events': []}, 'assets': EXAMPLE, 'out': out})
            self.assertEqual(code, 1)
            self.assertIn('recipe', answer['error'])

    def test_an_unknown_event_type_is_refused_before_drawing(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, _ = run(request(out, [{'type': 'no_such_type', 'at': 0}]))
            self.assertEqual(code, 1)
            self.assertIn("no event type ['no_such_type']", answer['error'])

    def test_a_sound_the_settings_do_not_hold_is_refused(self):
        look = json.loads(json.dumps(LOOK))
        del look['recipe']['sound']['events']['whoosh']
        with tempfile.TemporaryDirectory() as out:
            req = request(out, [STRIP, {'type': 'exit', 'at': 1.2}])
            req['settings'] = look
            code, answer, _ = run(req)
            self.assertEqual(code, 1)
            self.assertIn('`whoosh`', answer['error'])

    def test_settings_files_are_laid_under_settings(self):
        with tempfile.TemporaryDirectory() as out:
            req = request(out, [STRIP, {'type': 'exit', 'at': 1.2}])
            req.pop('settings')
            req['settings_files'] = [os.path.join(EXAMPLE, 'look.json')]
            req['settings'] = {'look3': {'safe_margin_px': 400}}
            code, answer, _ = run(req)
            self.assertEqual(code, 1)
            self.assertIn('400px margin', answer['error'], 'the request\'s own settings win over the file')


class Units(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from overlay import look
        look.install([LOOK], EXAMPLE, EXAMPLE, tempfile.mkdtemp())

    def test_every_event_module_binds_and_no_type_is_defined_twice(self):
        from overlay import events
        types = events.types()
        self.assertGreater(len(types), 110)
        for t in ('strip', 'exit', 'narrator_label', 'narrator_footnote', 'narrator_endcard', 'stapled_note', 'note', 'power_cut', 'causes'):
            self.assertIn(t, types)

    def test_spec_file_names_are_read_against_root_and_absolute_ones_kept(self):
        import render_a_motion_graphics_overlay as entry
        got = entry.resolve_files({'voice': {'wav': 'v.wav', 'words': 'w.json'}, 'events': [{'image': '/abs/p.png', 'words': 'said words', 'src': 'c.mp4'}],
                                   'still_bg': 'none'}, '/root')
        self.assertEqual(got['voice'], {'wav': '/root/v.wav', 'words': '/root/w.json'})
        self.assertEqual(got['events'][0], {'image': '/abs/p.png', 'words': 'said words', 'src': '/root/c.mp4'})
        self.assertEqual(got['still_bg'], 'none')

    def test_a_copy_of_a_recording_too_close_to_another_is_moved_later_and_trims_apply(self):
        from overlay import look
        from overlay.render import sound_events
        lib = {'pop': [{'file': 'a.wav', 'gain_db': -10}], 'roll-1': [{'file': 'b.wav', 'gain_db': -6}]}
        got = sound_events([('pop', 1.0), ('pop', 1.0), ('roll-1', 2.0)], lib, {'pop': 2, 'roll': -3})
        gap = look.LOOK3['sound_overlap']
        self.assertEqual(got[1]['t'], round(1.0 + gap['stagger_s'] * -(-gap['within_s'] // gap['stagger_s']), 3))
        self.assertEqual([g['gain_db'] for g in got], [-8, -8, -9])
        self.assertEqual(got[0]['file'], os.path.join(EXAMPLE, 'a.wav'))


class Lock(unittest.TestCase):
    """The render lock (ported from the old test_rounds.py render_lock checks)."""

    def test_reentrant_for_children_and_nested_calls_excludes_a_stranger_and_lowers_priority(self):
        from overlay.lock import render_lock
        child = ('import sys; sys.path.insert(0, {d!r}); from overlay.lock import render_lock\n'
                 'with render_lock({{"file": {f!r}}}):\n    print("rendered")')
        stranger = ('import fcntl\nf = open({f!r}, "a")\ntry:\n    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); print("got it")\n'
                    'except BlockingIOError:\n    print("excluded")')
        with tempfile.TemporaryDirectory() as d:
            lock = os.path.join(d, '.render.lock')
            with render_lock({'file': lock}):
                held = os.environ.get('OVERLAY_RENDER_LOCK_HELD')
                self.assertEqual(held, os.path.realpath(lock))
                self.assertGreaterEqual(os.getpriority(os.PRIO_PROCESS, 0), 19, 'the lowest priority (20 on macOS, 19 on Linux)')
                with render_lock({'file': lock}):
                    pass
                self.assertEqual(os.environ.get('OVERLAY_RENDER_LOCK_HELD'), held, 'the inner exit keeps the outer hold')
                out = subprocess.run([sys.executable, '-c', child.format(d=DO_WORK, f=lock)], capture_output=True, text=True, timeout=20).stdout.strip()
                self.assertEqual(out, 'rendered', 'a child of the holder runs')
                env = {k: v for k, v in os.environ.items() if k != 'OVERLAY_RENDER_LOCK_HELD'}
                out = subprocess.run([sys.executable, '-c', stranger.format(f=lock)], capture_output=True, text=True, env=env, timeout=20).stdout.strip()
                self.assertEqual(out, 'excluded', 'a process outside the holder waits')
            self.assertNotIn('OVERLAY_RENDER_LOCK_HELD', os.environ)
            with open(lock, 'a') as f:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)  # released on exit

    def test_waits_while_the_flag_says_so_and_gives_up_after_max_s(self):
        from overlay.lock import wait_while
        with tempfile.TemporaryDirectory() as d:
            flag = os.path.join(d, 'class')
            t = time.monotonic(); wait_while(flag, 'urgent', poll_s=0.05, max_s=0.3)
            self.assertLess(time.monotonic() - t, 0.1, 'no flag file: no wait')
            open(flag, 'w').write('normal\n')
            t = time.monotonic(); wait_while(flag, 'urgent', poll_s=0.05, max_s=0.3)
            self.assertLess(time.monotonic() - t, 0.1, 'another word: no wait')
            open(flag, 'w').write('urgent\n')
            t = time.monotonic(); wait_while(flag, 'urgent', poll_s=0.05, max_s=0.3)
            self.assertGreaterEqual(time.monotonic() - t, 0.3, 'the word: waits until max_s')


class SlideCard(unittest.TestCase):
    """A still slide (ported from the old test_slide_card.py)."""

    def render(self, out, text, cover=False, sizes=None, fit_with=None):
        event = {'type': 'slide_card', 'id': 'slide', 'text': text, 'label': 'A. Fixture', 'cover': cover, 'backdrop': 'kraft', 'rot': -1.0}
        if sizes:
            event['sizes'] = sizes
        if fit_with:
            event['fit_with'] = fit_with
        return run(request(out, [event], duration_s=0.05, canvas=(1080, 1350), stills=[0], spec_extra={'still_format': 'png', 'subtitles': False}))

    def test_a_canvas_spec_renders_one_png_of_that_size(self):
        for cover in (False, True):
            with tempfile.TemporaryDirectory() as out:
                code, answer, p = self.render(out, 'A fixture line of words that wraps onto a few lines of the card.', cover)
                self.assertEqual(code, 0, p.stderr[-800:])
                im = Image.open(answer['result']['stills'][0])
                self.assertEqual((im.format, im.size), ('PNG', (1080, 1350)))
                a = np.asarray(im.convert('RGB'), dtype=np.float32)
                corner, middle = np.median(a[:40, :40], axis=(0, 1)), np.median(a[600:750, 400:680], axis=(0, 1))
                self.assertGreater(corner[0] - corner[2], 40, 'the page edge is kraft (warm), not the grey still base')
                self.assertGreater(middle.min(), 200, 'the card in the middle is white paper')

    def test_fit_with_sets_the_carousels_one_size(self):
        def ink_height(fit_with):
            with tempfile.TemporaryDirectory() as out:
                code, answer, p = self.render(out, 'A short fixture line.', fit_with=fit_with)
                self.assertEqual(code, 0, p.stderr[-800:])
                a = np.asarray(Image.open(answer['result']['stills'][0]).convert('L'), dtype=np.float32)
            dark = np.nonzero((a < 70).sum(axis=1) > 3)[0]
            return dark.max() - dark.min()
        self.assertLess(ink_height([' '.join(['fixture words'] * 22)]), ink_height(None) * 0.9)

    def test_words_that_do_not_fit_stop_the_render(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, _ = self.render(out, ' '.join(['fixture'] * 400), sizes=[46])
            self.assertEqual(code, 1)
            self.assertIn('slide_card: "fixture fixture', answer['error'])


if __name__ == '__main__':
    unittest.main()
