"""The commands around the checks: pins (each check's pin against the reviewed ones), inspect (the numbers behind a verdict) and export-spans
(the source stretches a folder of specs plays, exported as placement base footage). Synthetic media and data only.
Run: python3 test/run_tests.py test_inspect_and_spans.py"""
import contextlib
import fcntl
import io
import json
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import LIMITS, Base, FPS, TypeSync, limits, write_overlay, write_video  # noqa: E402
from rendercheck import cli, jsonio, pins, spans  # noqa: E402
from rendercheck.checks import type_sync  # noqa: E402


def answer(argv):
    """(exit code, the result of the last printed line) of one command."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = cli.main(argv)
    return rc, json.loads(buf.getvalue().strip().splitlines()[-1])['result']


class Pins(Base):
    def test_a_changed_a_new_and_a_gone_check_are_named(self):
        now = pins.check_pins(limits())
        reviewed = {k: v for k, v in now.items() if k not in ('joins', 'tempo')}
        reviewed['in-frame'] = '0' * 64
        reviewed['a-retired-check'] = '1' * 64
        jsonio.write(self.path('reviewed.json'), reviewed)
        rc, r = answer(['pins', '--limits', LIMITS, '--reviewed', self.path('reviewed.json')])
        self.assertEqual(rc, 0)
        self.assertEqual(r['pins'], now)
        self.assertEqual([c['check'] for c in r['changed']], ['in-frame'])
        self.assertEqual(r['changed'][0]['now'], now['in-frame'])
        self.assertEqual(r['added'], ['joins', 'tempo'])
        self.assertEqual(r['gone'], ['a-retired-check'])

    def test_reviewed_pins_that_match_report_nothing_to_review(self):
        jsonio.write(self.path('reviewed.json'), pins.check_pins(limits()))
        _, r = answer(['pins', '--limits', LIMITS, '--reviewed', self.path('reviewed.json')])
        self.assertEqual((r['changed'], r['added'], r['gone']), ([], [], []))


class PlayedRanges(Base):
    """The source seconds each spec's preview plays (spans.needed, the old script's function), one range per run of consecutive frames."""
    def needed(self, edit, pad):
        os.makedirs(self.path('specs'), exist_ok=True)
        jsonio.write(os.path.join(self.path('specs'), 'a.json'), {'edit': edit})
        spans.FPS = FPS
        return [(lo, hi) for _, lo, hi in spans.needed(self.path('specs'), pad)]

    def test_a_plain_preview_plays_one_padded_range(self):
        self.assertEqual([(round(a, 3), round(b, 3)) for a, b in self.needed({'preview': [10.0, 12.0]}, 0.5)], [(9.5, 12.5)])

    def test_a_cut_splits_the_range_and_a_hold_adds_no_footage(self):
        got = self.needed({'preview': [10.0, 14.0], 'cuts': [[11.0, 12.0]], 'hold': {'at': 10.5, 'seconds': 1.0}}, 0.0)
        self.assertEqual(len(got), 3)      # before the hold, from the held frame on, after the cut: the held frame starts a new run
        self.assertEqual([[round(a, 2), round(b, 2)] for a, b in spans.union(got)], [[10.0, 11.0], [12.0, 14.0]])

    def test_a_stitched_opening_plays_its_pieces_first(self):
        got = self.needed({'preview': [0.0, 3.0], 'prepend': [[50.0, 51.0]]}, 0.0)
        self.assertEqual([(round(a, 2), round(b, 2)) for a, b in got], [(50.0, 51.0), (0.0, 2.0)])

    def test_a_spec_with_no_preview_plays_nothing(self):
        self.assertEqual(self.needed({}, 1.0), [])

    def test_union_and_subtract(self):
        self.assertEqual(spans.union([(5, 7), (0, 2), (1, 3)]), [[0, 3], [5, 7]])
        self.assertEqual(spans.subtract([[0, 10]], [[2, 3], [8, 12]]), [[0, 2], [3, 8]])


class ExportSpans(Base):
    def setUp(self):
        super().setUp()
        os.mkdir(self.path('specs'))
        jsonio.write(os.path.join(self.path('specs'), 'a.json'), {'edit': {'preview': [0.0, 1.0]}})
        cfg = limits()
        cfg['placement'] = dict(cfg['placement'], bases={'/lane/': [{'file': 'base-held.mp4', 'from': 5.0, 'to': 9.0}]})
        jsonio.write(self.path('limits.json'), cfg)

    def run_export(self, size, extra=()):
        exporter = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'testsrc=size={size}:rate={FPS}', '-t', '{to}', '-pix_fmt', 'yuv420p', '{out}']
        return answer(['export-spans', self.path('specs'), '--limits', self.path('limits.json'), '--bases-key', '/lane/', '--out-dir', self.path('out'),
                       '--export', json.dumps(exporter), '--fps', str(FPS), '--pad', '0', '--duration-tolerance-s', '0.2', *extra])

    def test_the_played_range_not_yet_held_is_exported_and_given_as_rows(self):
        w, h = limits()['frame']['width'], limits()['frame']['height']
        rc, r = self.run_export(f'{w}x{h}')
        self.assertEqual(rc, 0, r)
        self.assertEqual(r['to_export'], [[0.0, 1.0]])
        self.assertEqual(r['exported'], [{'file': 'base-0-1.mp4', 'from': 0.0, 'to': 1.0}])
        self.assertTrue(os.path.isfile(self.path('out/base-0-1.mp4')))

    def test_an_export_of_the_wrong_frame_size_is_refused(self):
        rc, r = self.run_export('320x180')
        self.assertEqual(rc, 1)
        self.assertEqual(r['exported'], [])
        self.assertIn('wanted', r['error'])

    def test_a_dry_run_exports_nothing_and_held_spans_are_not_exported_again(self):
        jsonio.write(os.path.join(self.path('specs'), 'b.json'), {'edit': {'preview': [6.0, 8.0]}})
        rc, r = self.run_export('1x1', ['--dry-run'])
        self.assertEqual(rc, 0)
        self.assertEqual(r['to_export'], [[0.0, 1.0]])
        self.assertFalse(os.path.exists(self.path('out')))

    def test_nothing_is_exported_while_the_projects_media_is_offline(self):
        jsonio.write(self.path('project.json'), {'project': {'items': {'m1': {'kind': {'Media': {'media': {'File': {'path': self.path('gone.mov')}}}}}}}})
        w, h = limits()['frame']['width'], limits()['frame']['height']
        rc, r = self.run_export(f'{w}x{h}', ['--project', self.path('project.json')])
        self.assertEqual(rc, 2)
        self.assertIn('offline', r['error'])
        self.assertFalse(os.path.exists(self.path('out')))

    def test_a_lock_the_parent_already_holds_is_not_waited_on(self):
        w, h = limits()['frame']['width'], limits()['frame']['height']
        lock = self.path('render.lock')
        with open(lock, 'a') as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            os.environ[spans.LOCK_HELD_ENV] = os.path.realpath(lock)
            try:
                rc, r = self.run_export(f'{w}x{h}', ['--lock', lock])
            finally:
                os.environ.pop(spans.LOCK_HELD_ENV, None)
        self.assertEqual(rc, 0, r)
        self.assertEqual(len(r['exported']), 1)


class InspectEyesAndPlacement(Base):
    def test_eyes_sorts_the_lower_eye_and_skips_pictures_without_a_face(self):
        jsonio.write(self.path('marks.json'), {'/x/a.jpg': [{'eye_open': [0.3, 0.2], 'mouth_open': 0.1}], '/x/b.jpg': [{'eye_open': [0.05, None], 'mouth_open': None}],
                                               '/x/c.jpg': [], '/x/d.jpg': [{'eye_open': [None, None], 'mouth_open': 0.4}]})
        rc, r = answer(['inspect', 'eyes', self.path('marks.json'), '--lowest', '1'])
        self.assertEqual(rc, 0)
        self.assertEqual((r['pictures'], r['with_a_face'], r['all_eye_open']), (4, 2, [0.05, 0.2]))
        self.assertEqual(r['lowest'], [{'picture': 'b.jpg', 'eye_open': 0.05, 'mouth_open': None}])

    def test_placement_rows_come_from_boxes_and_from_a_fail_row(self):
        jsonio.write(self.path('f.json'), {'_run': {}, '/v/a.mp4': {'placement': [{'status': 'INFO', 'data': {'boxes': {'card': {'heat': 0.734, 'exit': {'heat': 2.01}}, 'tag': {'heat': None}}}}]},
                                           '/v/b.mp4': {'placement': [{'status': 'FAIL', 'data': {'id': 'card', 'heat': 2.456, 'frames': 30}}]}})
        _, r = answer(['inspect', 'placement', self.path('f.json')])
        self.assertEqual(r['rows'][0]['boxes'], {'card': {'heat': 0.73, 'exit_heat': 2.01}, 'tag': {'heat': None, 'exit_heat': None}})
        self.assertEqual({k: r['rows'][1][k] for k in ('status', 'id', 'heat', 'frames')}, {'status': 'FAIL', 'id': 'card', 'heat': 2.46, 'frames': 30})


class InspectSettle(Base):
    def test_the_windows_are_the_landing_windows_settle_judges(self):
        n = FPS * 4
        frames = []
        for i in range(n):
            fr = np.zeros((90, 160, 4), np.uint8)
            x = 10 + min(i, 12) * 2
            fr[20:60, x:x + 40] = (255, 255, 255, 255)
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        jsonio.write(self.path('timeline.json'), {'elements': [{'id': 'card', 'at': 0.0}, {'id': 'card2', 'at': 2.0}], 'sounds': [], 'boxes': []})
        jsonio.write(self.path('s.json'), {'edit': {'overlay': {'at': 0}, 'preview': [0, 4.0]}, 'events': [{'type': 'words_q', 'id': 'card', 'at': 0.0}]})
        rc, r = answer(['inspect', 'settle', self.path('p.mp4'), '--spec', self.path('s.json'), '--limits', LIMITS, '--overlay', self.path('o.mov'),
                        '--timeline', self.path('timeline.json'), '--from', '0', '--to', '2'])
        self.assertEqual(rc, 0)
        self.assertEqual([w['window_s'][0] for w in r['windows']], [0.0, 2.0])
        self.assertEqual(len(r['traces']['raw']['mass']), len(r['traces']['unmasked']['mass']))
        self.assertGreater(max(r['motion_px_by_half_second'][:1]), 0.5)      # the block moves in the first half second
        self.assertEqual(r['motion_px_by_half_second'][-1], 0.0)             # and rests by the end


class InspectTypeSync(Base):
    TEXT = TypeSync.TEXT

    def test_each_typed_line_shows_its_reveal_times(self):
        ctx = TypeSync.ctx(self, 12)
        jsonio.write(self.path('s.json'), ctx.spec)
        rc, r = answer(['inspect', 'type-sync', self.path('p.mp4'), '--spec', self.path('s.json'), '--limits', LIMITS, '--overlay', self.path('overlay.mov')])
        self.assertEqual(rc, 0)
        [line] = r['lines']
        self.assertEqual(line['line'], self.TEXT)
        self.assertEqual(line['reveal'], type_sync.line_reveal(ctx, type_sync.line_boxes(ctx, ctx.spec['events'][0], [self.TEXT])[0], self.TEXT,
                                                               type_sync.speed(ctx.spec['events'][0], ctx.cfg['type_sync'])))
        self.assertGreater(line['live_frames'], 0)



if __name__ == '__main__':
    unittest.main()
