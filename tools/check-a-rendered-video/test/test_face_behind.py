"""face: an element that declares `occluded_by` and `matte` (words behind the speaker with a hole cut by the speaker's matte) is judged on the speaker's own pixels only; the margin beside the head is behind the speaker by
design, and anything really over the face still fails. Run: python3 test/run_tests.py"""
import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import Base, FPS, ctx_for, write_overlay, write_video  # noqa: E402
from rendercheck.checks import face  # noqa: E402
from rendercheck.report import verdict  # noqa: E402


class FaceBehind(Base):
    def ctx(self, hole=True, declared=True):
        """A wide block of words over the frame. The speaker's matte is x 72-88, y 15-85; with `hole` the block is cut there as the render does, without it the block lies over the speaker."""
        n = FPS * 3
        os.makedirs(self.path('mattes'), exist_ok=True)
        m = np.zeros((90, 160), np.uint8)
        m[15:85, 72:88] = 255
        fr = np.zeros((90, 160, 4), np.uint8)
        fr[10:80, 20:140] = (255, 255, 255, 255)
        if hole:
            fr[m > 0] = 0
        for i in range(n):
            cv2.imwrite(self.path(f'mattes/{i:04d}.png'), m)
        write_overlay(self.path('o.mov'), [fr] * n)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        ev = {'type': 'word_behind', 'id': 'q', 'at': 0.0, 'out': 3.0}
        if declared:
            ev.update({'occluded_by': 'person_matte', 'matte': self.path('mattes')})
        face.detect = lambda gray: [(280, 90, 80, 100)]          # a face at x 0.44-0.56, y 0.25-0.53: x 70-90 of 160, widened 15% by the check
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': 0}, 'preview': [0, 3.0]}, 'events': [ev]}, overlay=self.path('o.mov'))

    def test_words_behind_him_with_a_hole_where_he_stands_pass(self):
        fs = face.run(self.ctx())
        self.assertEqual(verdict(fs), 'PASS', [f.message for f in fs])

    def test_the_same_words_without_the_declaration_read_as_covering_the_margin_of_his_face(self):
        self.assertEqual(verdict(face.run(self.ctx(declared=False))), 'FAIL')

    def test_an_element_that_really_lies_over_his_face_still_fails_though_it_declares_a_matte(self):
        fs = face.run(self.ctx(hole=False))
        self.assertEqual(verdict(fs), 'FAIL', [f.message for f in fs])
        self.assertGreater(fs[0].data['cover'], 0.9)


if __name__ == '__main__':
    unittest.main()
