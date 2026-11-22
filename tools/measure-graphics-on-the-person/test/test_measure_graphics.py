"""Unit tests on synthetic masks and layers (no detection models): python3 test/test_measure_graphics.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'do-work'))

from measure_graphics import free, layers, measure, people, verdicts  # noqa: E402

W, H, FPS, N = 120, 200, 30, 3


def write_gray_video(path, frames):
    proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', f'{W}x{H}', '-r', str(FPS),
                             '-i', '-', '-c:v', 'ffv1', path], stdin=subprocess.PIPE)
    for f in frames:
        proc.stdin.write(np.where(f, 255, 0).astype(np.uint8).tobytes())
    proc.stdin.close()
    assert proc.wait() == 0


def write_alpha_video(path, frames):
    proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{W}x{H}', '-r', str(FPS),
                             '-i', '-', '-c:v', 'qtrle', '-pix_fmt', 'argb', path], stdin=subprocess.PIPE)
    for f in frames:
        rgba = np.zeros((H, W, 4), np.uint8)
        rgba[..., :3] = 200
        rgba[..., 3] = np.where(f, 255, 0)
        proc.stdin.write(rgba.tobytes())
    proc.stdin.close()
    assert proc.wait() == 0


def write_masks(out_dir, person_frames, face_frames):
    masks = os.path.join(out_dir, people.MASKS_DIR)
    os.makedirs(masks, exist_ok=True)
    per_frame = []
    for i, (p, f) in enumerate(zip(person_frames, face_frames)):
        cv2.imwrite(os.path.join(masks, f'person-{i:05d}.png'), np.where(p, 255, 0).astype(np.uint8))
        cv2.imwrite(os.path.join(masks, f'face-{i:05d}.png'), np.where(f, 255, 0).astype(np.uint8))
        per_frame.append({'frame': i, 't': round(i / FPS, 6), 'person_px': int(p.sum()), 'faces_found': 1 if f.any() else 0,
                          'face_unresolved': bool(p.any() and not f.any())})
    with open(os.path.join(masks, 'meta.json'), 'w') as fh:
        json.dump({'width': W, 'height': H, 'fps': FPS, 'frames': len(person_frames), 'per_frame': per_frame}, fh)


def box(x0, y0, x1, y1):
    m = np.zeros((H, W), bool)
    m[y0:y1, x0:x1] = True
    return m


ZONE_ROW = {'id': 'test-zone', 'frame_width': W, 'frame_height': H, 'safe': {'rect_px': {'x0': 10, 'x1': 110, 'y0': 20, 'y1': 180}}}
BAR_GRAPHICS = {'graphics_person_overlap_max': 0, 'any_layer_face_overlap_max': 0}


class LayerReadingTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_mask_video_reads_white_as_layer(self):
        path = os.path.join(self.dir, 'mask.mkv')
        frames = [box(10, 10, 30, 30), np.zeros((H, W), bool), box(0, 0, 5, 5)]
        write_gray_video(path, frames)
        got = list(layers.read_masks(path, W, H))
        self.assertEqual(len(got), N)
        for want, have in zip(frames, got):
            self.assertTrue(np.array_equal(want, have))

    def test_alpha_video_reads_alpha_as_layer(self):
        path = os.path.join(self.dir, 'alpha.mov')
        frames = [box(50, 50, 60, 60), np.zeros((H, W), bool), box(0, 0, 1, 1)]
        write_alpha_video(path, frames)
        got = list(layers.read_masks(path, W, H))
        self.assertEqual(len(got), N)
        for want, have in zip(frames, got):
            self.assertTrue(np.array_equal(want, have))

    def test_size_mismatch_is_refused_not_scaled(self):
        path = os.path.join(self.dir, 'mask.mkv')
        write_gray_video(path, [box(0, 0, 1, 1)])
        with self.assertRaises(layers.LayerError):
            list(layers.read_masks(path, W * 2, H))


class MeasureTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.rects = {'test-zone': free.zone_rect(ZONE_ROW, W, H)}

    def tearDown(self):
        shutil.rmtree(self.dir)

    def run_case(self, graphics, captions, person, face):
        out = os.path.join(self.dir, 'out')
        write_masks(out, [person] * N, [face] * N)
        paths = {}
        for name, frames in (('graphics', graphics), ('captions', captions), ('pose', [np.zeros((H, W), bool)] * N)):
            paths[name] = os.path.join(self.dir, f'{name}.mkv')
            write_gray_video(paths[name], frames)
        result = measure.measure_layers(out, paths, self.rects, W, H)
        summary = measure.summarize(result)
        return measure.laws_verdicts(result, summary, {
            'graphics-never-cover-the-person': dict(BAR_GRAPHICS),
            'everything-inside-platform-safe-zones': {'zones_from': 'rows'},
        }, {'test-zone': 'test-zone'})

    def test_graphics_on_the_person_fails_person_law(self):
        person = box(40, 60, 90, 180)
        face = box(45, 60, 60, 75)
        verdicts_ = self.run_case([box(50, 100, 70, 120)] * N, [np.zeros((H, W), bool)] * N, person, face)
        self.assertEqual(verdicts_['graphics-never-cover-the-person']['verdict'], 'fail')
        self.assertIn('graphics cover the person', verdicts_['graphics-never-cover-the-person']['reason'])

    def test_caption_on_torso_passes_but_on_face_fails(self):
        person = box(40, 60, 90, 180)
        face = box(45, 60, 60, 75)
        torso = self.run_case([np.zeros((H, W), bool)] * N, [box(50, 100, 80, 120)] * N, person, face)
        self.assertEqual(torso['graphics-never-cover-the-person']['verdict'], 'pass')
        on_face = self.run_case([np.zeros((H, W), bool)] * N, [box(50, 62, 58, 72)] * N, person, face)
        self.assertEqual(on_face['graphics-never-cover-the-person']['verdict'], 'fail')
        self.assertIn('captions covers the face', on_face['graphics-never-cover-the-person']['reason'])

    def test_graphic_outside_zone_fails_safe_zone_law(self):
        person = box(40, 60, 90, 180)
        face = box(45, 60, 60, 75)
        outside = self.run_case([box(0, 0, 10, 10)] * N, [np.zeros((H, W), bool)] * N, person, face)
        self.assertEqual(outside['everything-inside-platform-safe-zones']['verdict'], 'fail')
        inside = self.run_case([box(12, 22, 30, 40)] * N, [np.zeros((H, W), bool)] * N, person, face)
        self.assertEqual(inside['everything-inside-platform-safe-zones']['verdict'], 'pass')

    def test_person_without_face_fails_closed(self):
        person = box(40, 60, 90, 180)
        verdicts_ = self.run_case([np.zeros((H, W), bool)] * N, [np.zeros((H, W), bool)] * N, person, np.zeros((H, W), bool))
        self.assertEqual(verdicts_['graphics-never-cover-the-person']['verdict'], 'fail')
        self.assertIn('face not detected', verdicts_['graphics-never-cover-the-person']['reason'])


class FreeRegionTests(unittest.TestCase):
    def test_maximal_rects_cover_exactly_the_mask(self):
        mask = np.zeros((20, 30), bool)
        mask[2:10, 3:12] = True
        mask[12:18, 20:28] = True
        rects = free.maximal_rects(mask, 1)
        covered = np.zeros_like(mask)
        for r in rects:
            covered[r['y0']:r['y1'], r['x0']:r['x1']] = True
        self.assertTrue(np.array_equal(covered, mask))
        self.assertEqual(rects[0]['area'], max(r['area'] for r in rects))

    def test_free_region_keeps_margin_from_person_and_face(self):
        out = tempfile.mkdtemp()
        try:
            person = box(40, 0, 80, H)
            face = np.zeros((H, W), bool)
            write_masks(out, [person], [face])
            result = free.free_regions(out, 0, [ZONE_ROW], margin_px=10, min_side=5)
            for r in result['free']:
                self.assertTrue(r['x1'] <= 40 - 10 or r['x0'] >= 80 + 10, r)
            self.assertIsNotNone(result['largest'])
        finally:
            shutil.rmtree(out)

    def test_zone_rect_scales_to_picture_size(self):
        scaled = free.zone_rect(ZONE_ROW, W * 2, H * 2)
        self.assertEqual(scaled, {'x0': 20, 'x1': 220, 'y0': 40, 'y1': 360})

    def test_shared_rect_is_inside_every_zone(self):
        other = {'id': 'other', 'frame_width': W, 'frame_height': H, 'safe': {'rect_px': {'x0': 50, 'x1': 200, 'y0': 0, 'y1': 150}}}
        self.assertEqual(free.shared_zone_rect([ZONE_ROW, other], W, H), {'x0': 50, 'x1': 110, 'y0': 20, 'y1': 150})


class VerdictSqlTests(unittest.TestCase):
    def test_json_with_dollar_tag_is_quoted_safely(self):
        row = {'files_identity': 'blake3:x', 'format_id': 'f', 'check_id': 'c', 'verdict': 'fail',
               'measured': {'text': 'has $q$ inside'}, 'bar': {}, 'reason': "it's", 'evidence_ref': '/p', 'run': 'r'}
        sql = verdicts.upsert_sql(row)
        self.assertIn('ON CONFLICT (files_identity, check_id) DO UPDATE', sql)
        self.assertIn('$qq$', sql)
        self.assertNotIn("'it's'", sql)


if __name__ == '__main__':
    unittest.main()
