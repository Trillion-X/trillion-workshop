"""settle cuts a landing window at the true rests the picture shows, so separate beats are each judged as a landing, and a continuous slow ease (no rest in it) still fails.
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


class SettleRests(Base):
    def ctx(self, x_of_t, seconds=9):
        """One block on a transparent overlay whose left edge is x_of_t(second); the spec declares a single landing at 0 s."""
        n = FPS * seconds
        frames = []
        for i in range(n):
            fr = np.zeros((90, 160, 4), np.uint8)
            x = x_of_t(i / FPS)
            x0, frac = int(np.floor(x)), x - np.floor(x)      # sub-pixel position: the edge columns carry the fraction, as an antialiased render does
            fr[20:60, x0:x0 + 41] = (255, 255, 255, 255)
            fr[20:60, x0, 3] = int(255 * (1 - frac))
            fr[20:60, x0 + 40, 3] = int(255 * frac)
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        with open(self.path('timeline.json'), 'w') as f:
            json.dump({'elements': [{'id': 'card', 'at': 0.0}], 'sounds': [], 'boxes': []}, f)
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, float(seconds)]}, 'events': [{'type': 'words_q', 'id': 'card', 'at': 0.0}]}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))

    @staticmethod
    def beats(t):
        """Three quick beats (0.3 s moves of 12 px) with true rests of 3 s and 3.5 s between them."""
        def step(t0, a, b):
            return a if t < t0 else b if t > t0 + 0.3 else a + (b - a) * (t - t0) / 0.3
        return step(0.3, 20, 32) if t < 3.3 else step(3.6, 32, 44) if t < 7.0 else step(7.0, 44, 56)

    def series(self, ctx):
        a = ctx.overlay_alpha().astype(np.float32)
        ys, xs = np.mgrid[0:a.shape[1], 0:a.shape[2]]
        mass = a.sum(axis=(1, 2))
        scale = ctx.cfg['frame']['width'] / a.shape[2]
        n = int(ctx.cfg['settle']['smooth_s'] * ctx.overlay_fps())
        return (settle.smooth((a * xs).sum(axis=(1, 2)) / (mass + 1e-9) * scale, n), settle.smooth((a * ys[None]).sum(axis=(1, 2)) / (mass + 1e-9) * scale, n), mass)

    def test_quick_beats_with_true_rests_between_them_are_each_judged_and_pass(self):
        ctx = self.ctx(self.beats)
        fs = settle.run(ctx)
        self.assertEqual(verdict(fs), 'PASS', [f.message for f in fs])
        self.assertEqual(len(settle.split_at_rests(*self.series(ctx), 0, 200, ctx.overlay_fps(), ctx.cfg['settle'])), 3)

    def test_without_the_split_the_same_beats_read_as_one_slow_ease(self):
        ctx = self.ctx(self.beats)
        ctx.cfg['settle']['rest_split_s'] = 100.0
        fs = settle.run(ctx)
        self.assertEqual(verdict(fs), 'FAIL', [f.message for f in fs])

    def test_a_continuous_slow_ease_has_no_rest_to_cut_at_and_still_fails(self):
        ctx = self.ctx(lambda t: 20 + 20 * (1 - np.exp(-t / 2.2)))
        fs = settle.run(ctx)
        self.assertEqual(verdict(fs), 'FAIL', [f.message for f in fs])
        self.assertTrue(any('drags' in f.message or 'keeps moving' in f.message for f in fs))
        self.assertEqual(len(settle.split_at_rests(*self.series(ctx), 0, 200, ctx.overlay_fps(), ctx.cfg['settle'])), 1)

    def test_a_beat_that_drags_after_a_rest_still_fails_on_its_own(self):
        slow = lambda t: 20 if t < 3.0 else 20 + 20 * (1 - np.exp(-(t - 3.0) / 1.5))      # a rest, then a slow ease
        fs = settle.run(self.ctx(slow, seconds=10))
        self.assertEqual(verdict(fs), 'FAIL', [f.message for f in fs])


class SettleGeometryNotOpacity(Base):
    def ctx(self, shift_of_t=lambda t: 0.0, seconds=9):
        """Three words in a row, all drawn from the first frame at 0.75 opacity (the first is already nearly lit); they are spoken at -3, 0 and 1 s and each eases up to 1.0 with a 1.5 s time constant, so the total opacity keeps creeping up for seconds (kinetic_words lit). The row sits at shift_of_t(second) px."""
        n = FPS * seconds
        frames = []
        for i in range(n):
            t = i / FPS
            x0 = int(round(10 + shift_of_t(t)))
            fr = np.zeros((90, 160, 4), np.uint8)
            for k in range(3):
                alpha = 0.75 + 0.25 * (1 - np.exp(-max(t - (-3.0, 0.0, 1.0)[k], 0.0) / 1.5))
                fr[30:50, x0 + 45 * k:x0 + 45 * k + 30] = (255, 255, 255, int(round(255 * alpha)))
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        with open(self.path('timeline.json'), 'w') as f:
            json.dump({'elements': [{'id': 'card', 'at': 0.0}], 'sounds': [], 'boxes': []}, f)
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, float(seconds)]}, 'events': [{'type': 'words_q', 'id': 'card', 'at': 0.0}]}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))

    def test_words_that_brighten_in_a_box_that_does_not_move_pass(self):
        fs = settle.run(self.ctx())
        self.assertEqual(verdict(fs), 'PASS', [f.message for f in fs])
        self.assertIn('1 landing windows measured', fs[-1].message)      # judged, not skipped

    def test_the_same_words_easing_slowly_into_position_still_fail(self):
        fs = settle.run(self.ctx(lambda t: 20 * (1 - np.exp(-t / 2.2))))
        self.assertEqual(verdict(fs), 'FAIL', [f.message for f in fs])
        self.assertTrue(any('drags' in f.message or 'keeps moving' in f.message for f in fs))

    def test_the_silhouette_ignores_opacity_and_keeps_partial_edge_coverage(self):
        a = np.zeros((3, 1, 8), np.float32)
        a[0, 0, :4] = (255, 255, 255, 100)      # full opacity, the edge pixel covered 100/255
        a[1, 0, :4] = (191, 191, 191, 75)      # the same shape at 0.75 opacity: the same coverage
        a[2, 0, :4] = (255, 255, 255, 0)      # the edge pixel not covered
        s = settle.silhouette(a, 3)
        for frame in range(3):
            self.assertEqual(float(s[frame, 0, 0]), 255.0)
        ref = 100.0      # units are alpha: coverage times the most alpha the pixel ever shows
        self.assertAlmostEqual(float(s[0, 0, 3]) / ref, 100 / 255, places=3)
        self.assertAlmostEqual(float(s[1, 0, 3]) / ref, 100 / 255, places=2)
        self.assertEqual(float(s[2, 0, 3]), 0.0)


if __name__ == '__main__':
    unittest.main()
