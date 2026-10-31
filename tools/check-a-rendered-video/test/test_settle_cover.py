"""settle over an opaque full-frame cover: the overlay's total alpha and centroid are saturated there and see nothing, so each element is read from its own timeline box by the
change of its own pixels. A card that lands and sits still passes, one that keeps changing or sways fails, and a window with no readable element box is not measured, never a pass.
Run: python3 test/run_tests.py"""
import json
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import Base, FPS, ctx_for, write_overlay, write_video  # noqa: E402
from rendercheck.checks import settle  # noqa: E402
from rendercheck.report import verdict  # noqa: E402


class SettleOverCover(Base):
    def ctx(self, sway=0, boxes=True, covers=True):
        """A grey cover over the whole frame; a card lands on it at 0.5 s (fades in over 0.3 s) and then sits still, or sways `sway` px."""
        n = FPS * 8
        frames = []
        for i in range(n):
            t = i / FPS
            fr = np.zeros((90, 160, 4), np.uint8)
            fr[:, :] = (160, 160, 160, 255)
            if t >= 0.5:
                k = min((t - 0.5) / 0.3, 1.0)
                s = int(round(sway * np.sin(t * 2 * np.pi / 3))) if t > 1.5 else 0
                fr[20:60, 60 + s:100 + s, :3] = int(160 + 95 * k)
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        with open(self.path('timeline.json'), 'w') as f:
            json.dump({'elements': [{'id': 'cover', 'at': 0.0}, {'id': 'card', 'at': 0.5}], 'sounds': [],
                       'boxes': [{'id': 'card', 't0': 0.5, 'box': [600, 200, 1320, 760]}] if boxes else []}, f)
        events = [{'type': 'cover_c', 'id': 'cover', 'at': 0.0, 'covers_a_roll': True} if covers else {'type': 'sheet', 'id': 'cover', 'at': 0.0},
                  {'type': 'words_q', 'id': 'card', 'at': 0.5}]
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': 0}, 'preview': [0, 8.0]}, 'events': events}, overlay=self.path('o.mov'))

    def test_a_card_that_lands_on_the_cover_and_sits_still_passes_and_is_counted(self):
        fs = settle.run(self.ctx())
        self.assertEqual(verdict(fs), 'PASS', [f.message for f in fs])
        self.assertIn('1 landing windows measured', fs[-1].message)

    def test_a_card_that_keeps_swaying_on_the_cover_fails_though_the_total_alpha_never_moves(self):
        fs = settle.run(self.ctx(sway=3))
        self.assertEqual(verdict(fs), 'FAIL', [f.message for f in fs])
        self.assertIn('"card"', fs[0].message)
        self.assertIn('over a full-frame cover', fs[0].message)

    def test_with_no_readable_element_box_over_the_cover_nothing_is_measured_and_it_is_not_a_pass(self):
        fs = settle.run(self.ctx(boxes=False))
        self.assertEqual(verdict(fs), 'WARN', [f.message for f in fs])
        self.assertTrue(fs[0].data['not_measured'])
        self.assertIn('opaque full-frame cover', fs[0].message)

    def test_a_cover_is_not_its_own_element(self):
        ctx = self.ctx()
        ctx.timeline['boxes'] = [{'id': 'cover', 't0': 0.0, 'box': [0, 0, 1920, 1080]}]      # everything drawn on it is inside this box: it cannot say how one thing settles
        fs = settle.run(ctx)
        self.assertEqual(verdict(fs), 'WARN', [f.message for f in fs])


class LitWordsOverCover(Base):
    def ctx(self, shift_of_t=lambda t: 0.0, seconds=9):
        """Dark cover over the whole frame; from 0.5 s three words (bright blocks) in a row on it, drawn at 0.5 opacity and easing up to 1.0 (0.4 s time constant) when spoken at 1, 3 and 5.5 s (kinetic_words lit), the last one inside the rest part of the window; the row sits at shift_of_t(second) px."""
        n = FPS * seconds
        frames = []
        for i in range(n):
            t = i / FPS
            fr = np.zeros((90, 160, 4), np.uint8)
            fr[:, :] = (60, 60, 60, 255)
            if t >= 0.5:
                x0 = int(round(10 + shift_of_t(t)))
                for k in range(3):
                    o = 0.5 + 0.5 * (1 - np.exp(-max(t - (1.0, 3.0, 5.5)[k], 0.0) / 0.4))
                    fr[30:50, x0 + 45 * k:x0 + 45 * k + 30, :3] = int(round(60 * (1 - o) + 255 * o))
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        with open(self.path('timeline.json'), 'w') as f:
            json.dump({'elements': [{'id': 'cover', 'at': 0.0}, {'id': 'words', 'at': 0.5}], 'sounds': [],
                       'boxes': [{'id': 'words', 't0': 0.5, 'box': [100, 330, 1700, 630]}]}, f)
        events = [{'type': 'cover_c', 'id': 'cover', 'at': 0.0, 'covers_a_roll': True}, {'type': 'words_q', 'id': 'words', 'at': 0.5}]
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': 0}, 'preview': [0, float(seconds)]}, 'events': events}, overlay=self.path('o.mov'))

    def test_words_that_brighten_on_the_cover_in_a_box_that_does_not_move_pass(self):
        fs = settle.run(self.ctx())
        self.assertEqual(verdict(fs), 'PASS', [f.message for f in fs])
        self.assertIn('1 landing windows measured', fs[-1].message)

    def test_the_same_words_easing_slowly_into_position_on_the_cover_still_fail(self):
        fs = settle.run(self.ctx(lambda t: 20 * (1 - np.exp(-t / 2.2))))
        self.assertEqual(verdict(fs), 'FAIL', [f.message for f in fs])
        self.assertIn('over a full-frame cover', fs[0].message)


if __name__ == '__main__':
    unittest.main()
