"""edit.prepend (a stitched cold open): the time maps, the stitch points as joins, and the checks that must know the speech is edited. Run: python3 test/run_tests.py"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import Base, add_audio, moving, write_video, limits  # noqa: E402
from rendercheck import sfx  # noqa: E402
from rendercheck.ctx import Context  # noqa: E402
from rendercheck.checks import filler_words  # noqa: E402

def still(n):
    return [np.full((90, 160, 3), 40, np.uint8)] * n


PREPEND = [[10.0, 12.0], [20.0, 21.0]]      # stitched part = 3 s: source 10-12 then 20-21, the rest of the video follows from its second 0


class Prepend(Base):
    def ctx(self, edit, cfg=None):
        write_video(self.path('p.mp4'), moving(120))
        return Context(self.path('p.mp4'), {'edit': edit}, cfg or limits())

    def test_segments_run_in_listed_order_from_zero(self):
        c = self.ctx({'prepend': PREPEND})
        self.assertEqual(c.prepend_segments(), [(0.0, 2.0, 10.0), (2.0, 3.0, 20.0)])

    def test_stitch_points_are_joins_with_the_hand_off_into_the_video(self):
        j = self.ctx({'prepend': PREPEND, 'preview': [0, 5]}).joins()
        self.assertEqual([(x['t'], x['kind'], x['src_end'], x['src_start']) for x in j], [(2.0, 'cut', 12.0, 20.0), (3.0, 'cut', 21.0, 0.0)])

    def test_hold_shifts_the_stitch_points_after_it_and_adds_its_own(self):
        j = self.ctx({'prepend': PREPEND, 'hold': {'at': 1.0, 'seconds': 0.5}, 'preview': [0, 5]}).joins()
        self.assertEqual([(x['t'], x['kind'], x['src_end'], x['src_start']) for x in j],
                         [(1.0, 'hold-entry', 11.0, None), (1.5, 'hold-exit', None, 11.0), (2.5, 'cut', 12.0, 20.0), (3.5, 'cut', 21.0, 0.0)])

    def test_source_time_inside_and_after_the_stitch_with_hold_and_cuts(self):
        c = self.ctx({'prepend': PREPEND, 'hold': {'at': 1.0, 'seconds': 0.5}, 'cuts': [[5.0, 6.0]], 'preview': [0, 8]})
        self.assertAlmostEqual(c.source_time(0.5), 10.5)
        self.assertAlmostEqual(c.source_time(1.2), 11.0)      # inside the hold: its entry frame
        self.assertAlmostEqual(c.source_time(1.7), 11.2)
        self.assertAlmostEqual(c.source_time(3.0), 20.5)
        self.assertAlmostEqual(c.source_time(4.0), 0.5)       # the rest of the video's first second, after the stitched 3 s and the 0.5 s hold
        later = [x for x in c.joins() if x['t'] > 4]          # the cut at stitched 5-6 s: source second 2.0 ends, 3.0 resumes
        self.assertEqual([(x['t'], x['src_end'], x['src_start']) for x in later], [(5.5, 2.0, 3.0)])

    def test_without_prepend_nothing_changes(self):
        c = self.ctx({'hold': {'at': 1.0, 'seconds': 0.5}, 'cuts': [[5.0, 6.0]], 'preview': [0, 8]})
        self.assertEqual(c.prepend_segments(), [])
        self.assertEqual([(x['t'], x['kind'], x['src_end'], x['src_start']) for x in c.joins()],
                         [(1.0, 'hold-entry', 1.0, None), (1.5, 'hold-exit', None, 1.0), (5.5, 'cut', 5.0, 6.0)])
        self.assertEqual(c.source_spans(), [(0, 8)])

    def test_one_hold_as_a_list_maps_as_the_dict_does(self):
        one = {'hold': {'at': 1.0, 'seconds': 0.5}, 'cuts': [[5.0, 6.0]], 'preview': [0, 8]}
        a, b = self.ctx(one), self.ctx(dict(one, hold=[one['hold']]))
        self.assertEqual(a.joins(), b.joins())
        self.assertEqual([a.source_time(t) for t in (0.5, 1.2, 1.7, 6.0)], [b.source_time(t) for t in (0.5, 1.2, 1.7, 6.0)])

    def test_several_holds_shift_each_other_and_the_cuts_after_them(self):
        # holds at pre-hold 1.0 (0.5 s) and 3.0 (1.0 s), listed latest first; a cut removes edited 5-6; preview from 0.5
        c = self.ctx({'hold': [{'at': 3.0, 'seconds': 1.0}, {'at': 1.0, 'seconds': 0.5}], 'cuts': [[5.0, 6.0]], 'preview': [0.5, 9]})
        self.assertEqual(c.held_before(1.0), 0.5)
        self.assertEqual(c.held_before(2.9), 0.5)
        self.assertEqual(c.held_before(3.0), 1.5)
        self.assertEqual([(x['t'], x['kind'], x['src_end'], x['src_start']) for x in c.joins()],
                         [(0.5, 'hold-entry', 1.0, None), (1.0, 'hold-exit', None, 1.0), (3.0, 'hold-entry', 3.0, None), (4.0, 'hold-exit', None, 3.0),
                          (6.0, 'cut', 5.0, 6.0)])
        for t, src in ((0.2, 0.7), (0.7, 1.0), (1.5, 1.5), (2.9, 2.9), (3.5, 3.0), (4.0, 3.0), (4.5, 3.5), (6.5, 6.5)):
            self.assertAlmostEqual(c.source_time(t), src, msg=t)

    def test_source_spans_cover_the_stitched_pieces_and_the_video_after_them(self):
        self.assertEqual(self.ctx({'prepend': PREPEND, 'preview': [0, 8]}).source_spans(), [(10.0, 12.0), (20.0, 21.0), (0.0, 5.0)])
        self.assertEqual(self.ctx({'prepend': PREPEND, 'preview': [1, 2.5]}).source_spans(), [(11.0, 12.0), (20.0, 20.5)])
        self.assertEqual(self.ctx({'prepend': PREPEND, 'preview': [4, 8]}).source_spans(), [(1.0, 5.0)])

    def test_a_sound_base_of_another_length_is_not_used(self):
        write_video(self.path('p.mp4'), moving(120))
        write_video(self.path('base.mp4'), moving(120))
        add_audio(self.path('base.mp4'), np.zeros(16000 * 5, np.float32))
        write_video(self.path('long.mp4'), moving(240))
        add_audio(self.path('long.mp4'), np.zeros(16000 * 10, np.float32))
        spec = {'edit': {'preview': [0, 5]}}
        self.assertIsNotNone(sfx.base_audio(Context(self.path('p.mp4'), {**spec, 'sound_base': 'base.mp4'}, limits())))
        self.assertIsNone(sfx.base_audio(Context(self.path('p.mp4'), {**spec, 'sound_base': 'long.mp4'}, limits())))
        self.assertIsNone(sfx.base_audio(Context(self.path('p.mp4'), spec, limits())))

    def test_a_base_export_is_not_used_for_a_stitched_video(self):
        cfg = limits()
        cfg['sound_mix']['bases'] = {r'p\.mp4$': {'file': 'base.mp4', 't0': 0.0}}
        write_video(self.path('base.mp4'), still(120))
        add_audio(self.path('base.mp4'), np.zeros(16000 * 5, np.float32))
        write_video(self.path('p.mp4'), still(120))
        self.assertIn('base export', sfx.base_audio(Context(self.path('p.mp4'), {'edit': {'preview': [0, 5]}}, cfg))[1])
        self.assertIsNone(sfx.base_audio(Context(self.path('p.mp4'), {'edit': {'preview': [0, 5], 'prepend': PREPEND}}, cfg)))

    def test_a_plain_sibling_named_by_the_limits_is_the_sound_base(self):
        cfg = limits()
        cfg['sound_mix']['plain_sibling'] = [r'-\d+\.mp4$', '-0.mp4']
        for name in ('m1-2.mp4', 'm1-0.mp4'):
            write_video(self.path(name), still(120))
            add_audio(self.path(name), np.zeros(16000 * 5, np.float32))
        self.assertIn('plain sibling m1-0.mp4', sfx.base_audio(Context(self.path('m1-2.mp4'), {'edit': {'preview': [0, 5]}}, cfg))[1])
        self.assertIsNone(sfx.base_audio(Context(self.path('m1-2.mp4'), {'edit': {'preview': [0, 5]}}, limits())))

    def test_the_overlay_is_found_by_the_limits_overlay_globs(self):
        os.makedirs(self.path('videos'))
        write_video(self.path('videos/v-1.mp4'), still(24))
        os.makedirs(self.path('out-2/v-1'))
        write_video(self.path('out-2/v-1/overlay.mov'), still(24))
        self.assertIsNone(Context(self.path('videos/v-1.mp4'), {}, limits()).overlay)
        cfg = limits()
        cfg['analysis']['overlay_globs'] = ['../out*/{id}/overlay.mov']
        self.assertEqual(Context(self.path('videos/v-1.mp4'), {}, cfg).overlay, self.path('out-2/v-1/overlay.mov'))

    def test_filler_words_treats_a_stitch_as_editing_the_speech(self):
        self.assertEqual(filler_words.needs(self.ctx({'preview': [0, 5]})), filler_words.EMPTY_SET)
        self.assertNotEqual(filler_words.needs(self.ctx({'preview': [0, 5], 'prepend': PREPEND})), filler_words.EMPTY_SET)


if __name__ == '__main__':
    unittest.main()
