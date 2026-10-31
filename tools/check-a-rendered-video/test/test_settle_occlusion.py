"""settle on an element with an occlusion matte (words behind a person): the hole that follows the person is not the element moving; the element is judged unmasked,
and an element that really moves still fails. Run: python3 test/run_tests.py"""
import json
import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import Base, FPS, ctx_for, write_overlay, write_video  # noqa: E402
from rendercheck.checks import settle  # noqa: E402
from rendercheck.report import verdict  # noqa: E402


class SettleWithMatte(Base):
    def ctx(self, declared=True, sway=0, matte_folder='mattes', at=0.0):
        """Static (or swaying) words block with a 10 px wide hole that walks across it from frame 24 to 168, as a person's matte does."""
        n = FPS * 8
        os.makedirs(self.path('mattes'), exist_ok=True)
        frames = []
        for i in range(n):
            s = int(round(sway * np.sin(i / FPS * 2 * np.pi / 3))) if i > FPS else 0
            hole_x = 100 + int(30 * min(max(i - 24, 0) / 144, 1))
            fr = np.zeros((90, 160, 4), np.uint8)
            if i >= at * FPS:
                fr[20:60, 100 + s:140 + s] = (255, 255, 255, 255)
                fr[:, hole_x:hole_x + 10, 3] = 0
            frames.append(fr)
            m = np.zeros((90, 160), np.uint8)
            m[:, hole_x:hole_x + 10] = 255
            cv2.imwrite(self.path(f'mattes/{i:04d}.png'), m)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        with open(self.path('timeline.json'), 'w') as f:
            json.dump({'elements': [{'id': 'words', 'at': at}], 'sounds': [], 'boxes': [{'id': 'words', 't0': at, 'box': [1140, 200, 1860, 760]}]}, f)
        ev = {'type': 'word_behind', 'id': 'words', 'at': at}
        if declared:
            ev.update({'occluded_by': 'person_matte', 'matte': self.path(matte_folder)})
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': 0}, 'preview': [0, 8.0]}, 'events': [ev]}, overlay=self.path('o.mov'))

    def test_the_hole_of_a_declared_matte_is_not_the_element_moving(self):
        fs = settle.run(self.ctx())
        self.assertEqual(verdict(fs), 'PASS', [f.message for f in fs])

    def test_mattes_are_numbered_from_the_overlays_first_frame_not_the_elements(self):
        fs = settle.run(self.ctx(at=1.0))      # the words land at 1.0 s; matte 0000.png is still overlay frame 0
        self.assertEqual(verdict(fs), 'PASS', [f.message for f in fs])

    def test_without_the_declaration_the_same_moving_hole_still_reads_as_movement(self):
        self.assertEqual(verdict(settle.run(self.ctx(declared=False))), 'FAIL')

    def test_an_element_that_really_moves_still_fails_behind_its_matte(self):
        fs = settle.run(self.ctx(sway=8))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertTrue(any('keeps moving' in f.message for f in fs))

    def test_a_matte_folder_that_is_not_there_is_not_measured_not_a_pass(self):
        fs = settle.run(self.ctx(matte_folder='nowhere'))
        self.assertTrue(any(f.data.get('not_measured') for f in fs))
        self.assertNotEqual(verdict(fs), 'PASS')


if __name__ == '__main__':
    unittest.main()
