"""placement reads the footage under each graphic from base footage (the limits' placement.bases), not from the composite: a graphic that covers nearly
the whole frame hides nothing, and a range the base does not hold is UNREACHED (never a pass). Run: python3 test/run_tests.py"""
import json
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import Base, FPS, ctx_for, write_overlay, write_video  # noqa: E402
from rendercheck.checks import placement  # noqa: E402
from rendercheck.report import verdict  # noqa: E402


def placement_limit():
    from test_checks import limits
    return limits()['placement']['action_heat']


class PlacementFromBase(Base):
    def moving(self, n):
        rng = np.random.default_rng(5)
        return [np.repeat((rng.random((90, 160, 1)) * (np.arange(160) < 80)[None, :, None] * 255).astype(np.uint8), 3, axis=2) for _ in range(n)]      # all the motion on the left half

    def ctx(self, box, base_seconds=4.0, t0=0.0, preview=(0.0, 4.0), base_file='base.mp4', events=None, tear_at=None):
        n = FPS * 4
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 128, np.uint8)] * n)      # the composite: a flat picture, nothing moves in it
        write_video(self.path('base.mp4'), self.moving(int(FPS * base_seconds)), codec=('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '0'))
        ov = np.zeros((90, 160, 4), np.uint8)
        ov[:, :] = (255, 255, 255, 255)
        ov[40:50, 150:160] = 0      # the overlay covers all but a speck of the frame
        if tear_at is None:
            write_overlay(self.path('o.mov'), [ov] * n)
        else:      # a paper cover over the whole frame that is gone at tear_at seconds; the box (a print on it) stays: opaque only where the box is
            sheet = np.zeros_like(ov)
            sheet[box[1] // 12:box[3] // 12, box[0] // 12:box[2] // 12] = (255, 255, 255, 255)
            write_overlay(self.path('o.mov'), [ov] * int(tear_at * FPS) + [sheet] * (n - int(tear_at * FPS)))
        with open(self.path('timeline.json'), 'w') as f:
            json.dump({'elements': [], 'sounds': [], 'boxes': [{'id': 'g', 't0': 0.0, 'box': list(box)}]}, f)
        ctx = ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': preview[0]}, 'preview': list(preview)}, 'events': events or []}, overlay=self.path('o.mov'))
        ctx.cfg['placement']['bases'] = {r'p\.mp4$': [{'file': base_file, 'from': t0, 'to': t0 + base_seconds}]}
        return ctx

    def test_a_graphic_over_the_moving_footage_fails_though_the_overlay_covers_the_frame(self):
        fs = placement.run(self.ctx([100, 200, 500, 700]))
        self.assertEqual(verdict(fs), 'FAIL', [f.message for f in fs])

    def test_a_graphic_over_the_quiet_side_passes_and_reports_the_measured_change(self):
        fs = placement.run(self.ctx([1300, 200, 1800, 700]))
        self.assertEqual(verdict(fs), 'PASS')
        self.assertIn('highest mean change', fs[0].message)

    def test_the_base_is_read_at_the_source_seconds_the_video_plays(self):
        ctx = self.ctx([100, 200, 500, 700], base_seconds=8.0, t0=10.0, preview=(12.0, 16.0))
        self.assertEqual(verdict(placement.run(ctx)), 'FAIL')

    def test_a_range_the_base_does_not_hold_is_unreached_not_a_pass(self):
        fs = placement.run(self.ctx([1300, 200, 1800, 700], base_seconds=4.0, preview=(2.0, 6.0)))
        self.assertEqual(verdict(fs), 'WARN')
        self.assertTrue(fs[0].data['unreached'] and fs[0].data['not_measured'])
        self.assertIn('UNREACHED', fs[0].message)

    def test_a_range_is_read_from_the_span_that_holds_it_and_a_gap_between_spans_is_unreached(self):
        ctx = self.ctx([100, 200, 500, 700], base_seconds=8.0, t0=10.0, preview=(12.0, 16.0))
        write_video(self.path('far.mp4'), self.moving(int(FPS * 4)), codec=('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '0'))
        near = {'file': 'base.mp4', 'from': 10.0, 'to': 18.0}
        ctx.cfg['placement']['bases'] = {r'p\.mp4$': [{'file': 'far.mp4', 'from': 40.0, 'to': 44.0}, near]}
        self.assertEqual(verdict(placement.run(ctx)), 'FAIL')
        ctx.cfg['placement']['bases'] = {r'p\.mp4$': [{'file': 'far.mp4', 'from': 40.0, 'to': 44.0}, {'file': 'base.mp4', 'from': 10.0, 'to': 14.0}]}
        fs = placement.run(ctx)
        self.assertEqual(verdict(fs), 'WARN')
        self.assertIn('none of the base spans', fs[0].message)

    COVER = {'type': 'cover_sweep', 'id': 'sweep', 'at': 0.0, 'until': 2.0, 'covers_a_roll': True}

    def test_a_box_is_measured_only_while_it_is_over_visible_footage_not_over_a_full_frame_cover(self):
        on_hands = [100, 200, 500, 700]
        covered = placement.run(self.ctx(on_hands, events=[dict(self.COVER, until=4.0)], tear_at=4.0))      # the cover is there the whole time: the box hides no footage
        self.assertEqual(verdict(covered), 'PASS')
        self.assertIn('never over visible footage', covered[0].message)
        self.assertIn('under the full-frame cover "sweep"', covered[0].message)
        torn = placement.run(self.ctx(on_hands, events=[self.COVER], tear_at=2.0))      # the cover tears at 2.0 s and the same box is then over the moving hands
        self.assertEqual(verdict(torn), 'FAIL')
        self.assertIn('over 47 frames', torn[0].message)
        self.assertTrue(torn[0].t >= 2.0 - 0.05)

    def test_a_box_over_the_quiet_side_after_the_cover_passes_with_its_number_and_the_cover_is_named(self):
        fs = placement.run(self.ctx([1300, 200, 1800, 700], events=[self.COVER], tear_at=2.0))
        self.assertEqual(verdict(fs), 'PASS')
        self.assertEqual(fs[0].data['boxes']['g']['frames'], 47)
        self.assertLess(fs[0].data['boxes']['g']['heat'], placement_limit())

    def test_a_cover_with_no_known_end_excuses_nothing(self):
        no_end = {k: v for k, v in self.COVER.items() if k != 'until'}
        self.assertEqual(verdict(placement.run(self.ctx([100, 200, 500, 700], events=[no_end]))), 'FAIL')

    def test_the_exit_after_the_cover_is_measured_and_reported_apart_never_exempted(self):
        fs = placement.run(self.ctx([100, 200, 500, 700], events=[self.COVER], tear_at=2.0))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('exit window', fs[0].message)
        self.assertIn('over 47 frames', fs[0].message)
        self.assertIn('no box for it after the cover ends', fs[0].message)
        self.assertEqual(fs[0].data['id'], 'g')

    def test_a_moving_box_is_followed_at_its_per_frame_position(self):
        ctx = self.ctx([100, 200, 500, 700], events=[self.COVER], tear_at=2.0)      # the overlay's print is on the moving side; the timeline has it on the quiet side until 2.5 s, then here
        ctx.timeline['boxes'] = [{'id': 'g', 't0': 0.0, 'box': [1300, 200, 1800, 700]}, {'id': 'g', 't0': 2.5, 'box': [100, 200, 500, 700]}]
        r = placement.base_boxes(ctx, ctx.cfg['placement'], placement.base_diffs(ctx, ctx.cfg['placement'], placement.base_footage(ctx, ctx.cfg['placement']))[0])['g']
        self.assertTrue(r['exit']['followed'])
        self.assertGreater(r['exit']['heat'], placement_limit())
        self.assertLess(r['exit']['from'], 2.6)      # measured from 2.5 s at the new place; before it the print is not under the recorded box

    def test_a_range_that_crosses_from_one_span_into_the_next_adjacent_one_is_read_from_both(self):
        ctx = self.ctx([100, 200, 500, 700], base_seconds=8.0, t0=10.0, preview=(12.0, 16.0))
        for name in ('b1', 'b2'):
            write_video(self.path(name + '.mp4'), self.moving(int(FPS * 4)), codec=('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '0'))
        ctx.cfg['placement']['bases'] = {r'p\.mp4$': [{'file': 'b1.mp4', 'from': 10.0, 'to': 14.0}, {'file': 'b2.mp4', 'from': 14.0, 'to': 18.0}]}      # the video plays the source 12-16 s across the seam
        fs = placement.run(ctx)
        self.assertEqual(verdict(fs), 'FAIL', [f.message for f in fs])
        self.assertGreaterEqual(fs[0].data['frames'], 90)      # all of the 4 s but the change at the seam
        ctx.cfg['placement']['bases'] = {r'p\.mp4$': [{'file': 'b1.mp4', 'from': 10.0, 'to': 14.0}, {'file': 'b2.mp4', 'from': 14.5, 'to': 18.0}]}      # a gap at the seam is not bridged
        self.assertEqual(verdict(placement.run(ctx)), 'WARN')

    def test_files_are_named_from_the_lane_folder_wherever_the_video_sits(self):
        ctx = self.ctx([100, 200, 500, 700])
        lane = self.path('lane-a')
        os.makedirs(lane + '/work')
        os.makedirs(lane + '/round-2/working')
        os.replace(self.path('base.mp4'), lane + '/work/base.mp4')
        os.replace(self.path('p.mp4'), lane + '/round-2/working/p.mp4')
        ctx.preview = lane + '/round-2/working/p.mp4'
        ctx.cfg['placement']['bases'] = {'/lane-a/': [{'file': 'work/base.mp4', 'from': 0.0, 'to': 4.0}]}
        self.assertEqual(verdict(placement.run(ctx)), 'FAIL')

    def test_a_missing_base_file_is_unreached_not_a_pass(self):
        fs = placement.run(self.ctx([1300, 200, 1800, 700], base_file='gone.mp4'))
        self.assertEqual(verdict(fs), 'WARN')
        self.assertIn('not on disk', fs[0].message)


if __name__ == '__main__':
    unittest.main()
