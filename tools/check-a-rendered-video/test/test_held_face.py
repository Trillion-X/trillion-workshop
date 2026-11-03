"""held-face: a hold must not freeze on a blink or half-closed eyes, nor (long) on a mouth caught mid-word. The face landmark reader (Apple Vision) is stubbed
with canned faces, so the verdict logic is tested on any computer. Run: python3 test/run_tests.py"""
import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import Base, FPS, ctx_for, write_video  # noqa: E402
from rendercheck.checks import held_face  # noqa: E402
from rendercheck.report import verdict  # noqa: E402


class HeldFace(Base):
    def ctx(self, hold=None, seconds=4):
        """A video of `seconds` that is one still picture (a hold plays a still), with the hold in the spec."""
        write_video(self.path('p.mp4'), [np.full((1080, 1920, 3), 90, np.uint8)] * int(FPS * seconds))
        edit = {'preview': [0, float(seconds)]}
        if hold is not False:
            edit['hold'] = hold or {'at': 0.0, 'seconds': float(seconds)}
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': edit, 'events': []})

    def still(self, name):
        path = self.path(name)
        cv2.imwrite(path, np.full((1080, 1920, 3), 90, np.uint8))
        return path

    def faces(self, eye, mouth=0.1):
        return lambda ctx, images: {images[0]: [{'box': [0.4, 0.5, 0.1, 0.2], 'eye_open': [eye, eye + 0.01], 'mouth_open': mouth}]}

    def run_with(self, ctx, reader):
        real, held_face.read_landmarks = held_face.read_landmarks, reader
        try:
            return held_face.run(ctx)
        finally:
            held_face.read_landmarks = real

    def test_eyes_under_the_threshold_fail_and_open_eyes_pass(self):
        fs = self.run_with(self.ctx(), self.faces(0.24))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('eyes are 0.24 open', fs[0].message)
        self.assertEqual(verdict(self.run_with(self.ctx(), self.faces(0.36))), 'PASS')

    def test_a_long_hold_on_a_mid_word_mouth_warns_and_a_short_one_does_not(self):
        fs = self.run_with(self.ctx(), self.faces(0.36, mouth=0.6))
        self.assertEqual(verdict(fs), 'WARN')
        self.assertIn('mid-word', fs[0].message)
        short = self.ctx(hold={'at': 0.0, 'seconds': 1.0})
        self.assertEqual(verdict(self.run_with(short, self.faces(0.36, mouth=0.6))), 'PASS')

    def test_a_blink_on_a_very_short_flash_hold_is_not_judged_but_a_half_second_hold_is(self):
        self.assertEqual(verdict(self.run_with(self.ctx(hold={'at': 0.0, 'seconds': 0.3}), self.faces(0.1))), 'PASS')
        self.assertEqual(verdict(self.run_with(self.ctx(hold={'at': 0.0, 'seconds': 0.6}), self.faces(0.1))), 'FAIL')

    def test_no_face_or_no_reader_is_not_measured_never_a_pass(self):
        fs = self.run_with(self.ctx(), lambda ctx, images: {p: [] for p in images})
        self.assertEqual(verdict(fs), 'WARN')
        self.assertTrue(fs[0].data['not_measured'])
        fs = self.run_with(self.ctx(), lambda ctx, images: None)
        self.assertEqual(verdict(fs), 'WARN')
        self.assertIn('not available', fs[0].message)

    def test_without_a_landmarks_python_the_reader_is_not_available(self):
        ctx = self.ctx()
        env = os.environ.pop('LANDMARKS_PYTHON', None)
        try:
            self.assertIsNone(held_face.read_landmarks(ctx, [self.still('x.png')]))
            os.environ['LANDMARKS_PYTHON'] = self.path('no-such-python')
            self.assertIsNone(held_face.read_landmarks(ctx, [self.still('x.png')]))
        finally:
            os.environ.pop('LANDMARKS_PYTHON', None)
            if env is not None:
                os.environ['LANDMARKS_PYTHON'] = env

    def test_a_spec_with_no_hold_is_an_empty_set(self):
        self.assertTrue(held_face.needs(self.ctx(hold=False)).startswith(held_face.EMPTY_SET))
        self.assertIsNone(held_face.needs(self.ctx()))

    def test_a_still_laid_over_the_whole_frame_is_the_held_picture(self):
        ctx = self.ctx()
        still = self.still('open.png')
        ctx.spec['events'] = [{'type': 'hold_still', 'id': 'hs', 'image': still, 'covers_a_roll': True}]
        seen = []
        self.run_with(ctx, lambda c, images: seen.append(images) or {images[0]: []})
        self.assertEqual(seen[0], [still])

    def test_a_hold_picture_is_the_picture_shown_and_a_missing_file_is_not_measured(self):
        ctx = self.ctx(hold=False)
        still = self.still('open.png')
        ctx.edit['hold_picture'] = {'image': 'open.png', 'at': 0.0, 'seconds': 3.0}      # relative: beside the video, with no lane_root_regex match
        ctx.edit['hold'] = {'at': 0.0, 'seconds': 3.0}      # the footage hold stays as it is; the still plays over it
        seen = []
        fs = self.run_with(ctx, lambda c, images: seen.append(images) or {images[0]: [{'box': [0.4, 0.5, 0.1, 0.2], 'eye_open': [0.36, 0.37], 'mouth_open': 0.1}]})
        self.assertEqual(seen[0], [still])
        self.assertEqual(verdict(fs), 'PASS')
        self.assertIn('hold_picture still', fs[0].message)
        ctx.edit['hold_picture']['image'] = 'nowhere.png'
        fs = self.run_with(ctx, self.faces(0.36))
        self.assertEqual(verdict(fs), 'WARN')
        self.assertIn('not on disk', fs[0].message)

    def test_the_hold_is_placed_by_the_video_start(self):
        ctx = self.ctx(hold={'at': 12.0, 'seconds': 2.0}, seconds=4)
        ctx.edit['preview'] = [11.0, 15.0]
        ctx.p0 = 11.0
        self.assertEqual(held_face.holds(ctx), [(1.0, 2.0, None)])

    def test_each_of_several_holds_is_judged_on_its_own_picture(self):
        ctx = self.ctx(hold=[{'at': 2.0, 'seconds': 0.5}, {'at': 0.5, 'seconds': 0.5}], seconds=4)      # unsorted, as a spec may list them
        open_still, shut_still = self.still('open.png'), self.still('shut.png')
        ctx.edit['hold_picture'] = [{'image': shut_still, 'at': 2.5, 'seconds': 0.5}, {'image': open_still, 'at': 0.5, 'seconds': 0.5}]      # final times: 0.5 and 2.0 + 0.5
        self.assertEqual([(s, secs, p['image']) for s, secs, p in held_face.holds(ctx)], [(0.5, 0.5, open_still), (2.5, 0.5, shut_still)])
        fs = self.run_with(ctx, lambda ctx, images: {images[0]: [{'box': [0.4, 0.5, 0.1, 0.2], 'eye_open': [0.1 if images[0] == shut_still else 0.4] * 2, 'mouth_open': 0.1}]})
        self.assertEqual([(f.status, f.t) for f in fs], [('INFO', 0.5), ('FAIL', 2.5)])

    def test_with_base_footage_the_hold_reads_the_base_at_its_source_second(self):
        ctx = self.ctx(hold={'at': 1.0, 'seconds': 1.0})
        write_video(self.path('base.mp4'), [np.full((1080, 1920, 3), 60, np.uint8)] * (FPS * 4))
        ctx.cfg['placement']['bases'] = {r'p\.mp4$': [{'file': 'base.mp4', 'from': 0.0, 'to': 4.0}]}
        seen = []
        fs = self.run_with(ctx, lambda c, images: seen.append(images) or {images[0]: [{'box': [0.4, 0.5, 0.1, 0.2], 'eye_open': [0.4, 0.4], 'mouth_open': 0.1}]})
        self.assertEqual(len(seen[0]), 1)
        self.assertIn('base footage at source second 1.00', fs[0].message)
        ctx.cfg['placement']['bases'] = {r'p\.mp4$': [{'file': 'gone.mp4', 'from': 0.0, 'to': 4.0}]}
        fs = self.run_with(ctx, self.faces(0.4))
        self.assertEqual(verdict(fs), 'WARN')
        self.assertTrue(fs[0].data['unreached'])


if __name__ == '__main__':
    unittest.main()
