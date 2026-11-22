"""Unit tests on synthetic boxes (no detection model): python3 test/test_frame_the_movement.py"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'do-work'))

import frame_the_movement as ftm  # noqa: E402

SRC_W, SRC_H = 3840, 2160
OUT_W, OUT_H = 1080, 1920
LAYOUTS = [
    {'name': 'full-bleed-9x16', 'aspect': 9 / 16, 'sizing': 'full-height'},
    {'name': 'wide-with-blurred-bars', 'aspect': 1.0, 'sizing': 'around-movement'},
    {'name': 'stacked-synced-comparison', 'aspect': OUT_W / (OUT_H / 2), 'sizing': 'around-movement'},
    {'name': 'follow-and-widen', 'aspect': 9 / 16, 'sizing': 'follow'},
]


def shot(boxes, sid='s'):
    return {'id': sid, 'frames': [{'t': i / 6, 'box': b, 'subject': b} for i, b in enumerate(boxes)]}


def candidate(name, frames, margin=0.08, reach=3):
    layout = next(x for x in LAYOUTS if x['name'] == name)
    return ftm._candidate(layout, shot(frames), SRC_W, SRC_H, OUT_W, OUT_H, margin, reach, 1.25)


class TestFullBleed(unittest.TestCase):
    def test_movement_inside_full_height_window_passes(self):
        c = candidate('full-bleed-9x16', [[1500, 200, 2100, 1900]] * 10)
        self.assertTrue(c['fits'])
        self.assertEqual(c['out_of_view_frames'], 0)

    def test_wide_swing_crosses_the_edge_and_is_counted(self):
        frames = [[1500, 200, 2100, 1900]] * 5 + [[300, 200, 3500, 1900]] * 5
        c = candidate('full-bleed-9x16', frames)
        self.assertFalse(c['fits'])
        self.assertEqual(c['out_of_view_frames'], 5)

    def test_full_height_window_is_the_whole_source_height(self):
        self.assertEqual(ftm._static_window(LAYOUTS[0], [0, 0, 10, 10], SRC_W, SRC_H, 0.08)[3], SRC_H)


class TestAroundMovement(unittest.TestCase):
    def test_square_window_holds_the_whole_extent(self):
        frames = [[1000, 200, 2800, 1900]] * 10
        c = candidate('wide-with-blurred-bars', frames)
        self.assertTrue(c['fits'])
        self.assertEqual(c['out_of_view_frames'], 0)
        x, y, w, h = c['window']
        self.assertAlmostEqual(w, h)
        self.assertLessEqual(x, 1000)
        self.assertGreaterEqual(x + w, 2800)

    def test_extent_larger_than_the_source_does_not_fit(self):
        c = candidate('wide-with-blurred-bars', [[100, 0, 1500, 2160]] * 3)
        self.assertFalse(c['fits'])
        self.assertIsNone(c['window'])


class TestFollow(unittest.TestCase):
    def test_follow_moves_with_the_movement(self):
        frames = [[200 + 30 * i, 300, 1000 + 30 * i, 1900] for i in range(10)]
        c = candidate('follow-and-widen', frames, reach=1)
        self.assertTrue(c['fits'])
        self.assertEqual(c['out_of_view_frames'], 0)


class TestChoose(unittest.TestCase):
    def test_first_passing_layout_in_request_order_is_picked(self):
        with tempfile.TemporaryDirectory() as out:
            frames = [[1000, 200, 2800, 1900]] * 6
            ftm._write(os.path.join(out, 'boxes.json'), {'source': [SRC_W, SRC_H], 'shots': [dict(shot(frames), start=0, end=1)]})
            result = ftm.choose({'out': out, 'output': [OUT_W, OUT_H], 'layouts': LAYOUTS, 'margin': 0.08,
                                 'follow_window_frames': 3, 'max_zoom': 1.25, 'safe_margin_px': 60})
            self.assertEqual(result['shots'][0]['picked'], 'wide-with-blurred-bars')
            self.assertEqual(len(result['shots'][0]['graphic_areas']), 2)
            self.assertTrue(result['gate']['passes'])
            with open(os.path.join(out, 'framing.json')) as f:
                self.assertEqual(json.load(f)['gate']['out_of_view_frames'], 0)

    def test_no_passing_layout_fails_the_gate(self):
        with tempfile.TemporaryDirectory() as out:
            ftm._write(os.path.join(out, 'boxes.json'), {'source': [SRC_W, SRC_H], 'shots': [dict(shot([[100, 0, 1500, 2160]] * 3), start=0, end=1)]})
            result = ftm.choose({'out': out, 'output': [OUT_W, OUT_H], 'layouts': LAYOUTS[:2], 'margin': 0.08,
                                 'follow_window_frames': 3, 'max_zoom': 1.25, 'safe_margin_px': 60})
            self.assertFalse(result['gate']['passes'])
            self.assertEqual(result['gate']['unpicked_shots'], ['s'])


class TestGraphicAreas(unittest.TestCase):
    def test_square_window_leaves_a_band_above_and_below(self):
        areas = ftm.graphic_areas('wide-with-blurred-bars', [0, 0, 2160, 2160], OUT_W, OUT_H, 60)
        self.assertEqual(areas, [[0, 60, 1080, 300], [0, 1560, 1080, 300]])

    def test_full_bleed_and_follow_give_no_area(self):
        self.assertEqual(ftm.graphic_areas('full-bleed-9x16', [0, 0, 1215, 2160], OUT_W, OUT_H, 60), [])
        self.assertEqual(ftm.graphic_areas('follow-and-widen', [0, 0, 1215, 2160], OUT_W, OUT_H, 60), [])

    def test_unknown_layout_fails_loud(self):
        with self.assertRaises(SystemExit):
            ftm.graphic_areas('some-new-layout', [0, 0, 1, 1], OUT_W, OUT_H, 60)


class TestGate(unittest.TestCase):
    def test_gate_exits_one_when_a_shot_has_no_layout(self):
        with tempfile.TemporaryDirectory() as out:
            ftm._write(os.path.join(out, 'framing.json'), {'gate': {'out_of_view_frames': 4, 'unpicked_shots': ['s'], 'passes': False}})
            with self.assertRaises(SystemExit) as raised:
                ftm.gate({'out': out})
            self.assertEqual(raised.exception.code, 1)

    def test_gate_passes_with_zero_frames_out_of_view(self):
        with tempfile.TemporaryDirectory() as out:
            ftm._write(os.path.join(out, 'framing.json'), {'gate': {'out_of_view_frames': 0, 'unpicked_shots': [], 'passes': True}})
            self.assertTrue(ftm.gate({'out': out})['passes'])


if __name__ == '__main__':
    unittest.main()
