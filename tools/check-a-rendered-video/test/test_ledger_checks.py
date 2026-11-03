"""The checks that read a film made as several options per moment: variety and devices (the technique ledger), placement's side balance, reused-footage
(the cut project and the pick files), label-time (ledger, pick headings and watch file names), the ledger commands (variety, declare, map-add, and the lock
they share) and review-pack. Every folder, ledger, project and video is made up in a temporary folder. Run: python3 test/run_tests.py"""
import contextlib
import io
import json
import os
import subprocess
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import LIMITS, Base, FPS, ctx_for, moving, write_video  # noqa: E402
from rendercheck import jsonio  # noqa: E402
from rendercheck.checks import devices, label_time, placement, reused_footage, variety  # noqa: E402
from rendercheck.report import verdict  # noqa: E402

DO_WORK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work')


def flat(n=FPS):
    return [np.full((90, 160, 3), 40, np.uint8)] * n


class Variety(Base):
    """Ledger rows are written in <tmp>/film/ledger/, beside a tiny video under <tmp>/film/lane-b/previews-1/; the spec lists event types."""

    MAP = {'neutral_event_types': ['pause'], 'techniques': {
        'scatter-exit': {'event_types': ['scatter'], 'chapter1': True}, 'chart-card': {'event_types': ['chart'], 'chapter1': False},
        'zoom-detail': {'event_types': ['zoom'], 'chapter1': False}, 'cutaway': {'event_types': [], 'chapter1': False}}}

    def setup_film(self, rows, option='o-a', events=('scatter',), folder='lane-b'):
        full = self.path('film/ledger')
        os.makedirs(full)
        with open(os.path.join(full, 'technique-ledger.jsonl'), 'w') as f:
            f.write('\n'.join(json.dumps(r) for r in rows) + '\n')
        jsonio.write(os.path.join(full, 'technique-map.json'), self.MAP)
        pv = self.path(f'film/{folder}/previews-1')
        os.makedirs(pv)
        write_video(os.path.join(pv, option + '.mp4'), moving(6))
        return ctx_for(self.tmp, os.path.join(pv, option + '.mp4'), {'events': [{'type': e} for e in events]})

    @staticmethod
    def row(option, t, ids, lane='b'):
        return {'lane': lane, 'option_id': option, 'moment_time': t, 'technique_ids': ids, 'kind': 'x'}

    def messages(self, ctx):
        return [f.message for f in variety.run(ctx) if f.status == 'FAIL']

    def test_a_video_outside_the_scope_is_outside_the_ledger(self):
        ctx = self.setup_film([], folder='lane-a')
        self.assertTrue(variety.needs(ctx).startswith(variety.EMPTY_SET))

    def test_a_declared_option_that_matches_its_spec_passes(self):
        ctx = self.setup_film([self.row('o-a', '2:19', ['scatter-exit'])])
        self.assertIsNone(variety.needs(ctx))
        self.assertEqual(self.messages(ctx), [])

    def test_an_option_with_no_row_fails(self):
        ctx = self.setup_film([self.row('o-b', '2:19', ['chart-card'])])
        self.assertIn('no row', self.messages(ctx)[0])

    def test_under_declaring_fails(self):
        ctx = self.setup_film([self.row('o-a', '2:19', ['chart-card'])], events=('scatter', 'chart'))
        self.assertTrue(any('under-declared' in m and 'scatter-exit' in m for m in self.messages(ctx)))

    def test_an_event_type_in_no_technique_fails_and_neutral_ones_do_not(self):
        ctx = self.setup_film([self.row('o-a', '2:19', ['chart-card'])], events=('chart', 'pause', 'wobble'))
        msgs = self.messages(ctx)
        self.assertEqual(len(msgs), 1)
        self.assertIn('wobble', msgs[0])

    def test_an_unknown_technique_id_fails(self):
        ctx = self.setup_film([self.row('o-a', '2:19', ['made-up'])], events=())
        self.assertTrue(any('not in technique-map' in m for m in self.messages(ctx)))

    def test_a_technique_in_a_fourth_moment_fails(self):
        rows = [self.row('o-a', '2:19', ['chart-card'])] + [self.row(f'x{i}', 160 + 60 * i, ['chart-card'] if i % 2 == 0 else ['zoom-detail', 'chart-card']) for i in range(3)]
        ctx = self.setup_film(rows, events=('chart',))
        self.assertTrue(any('used in 4 moments' in m for m in self.messages(ctx)))

    def test_three_moments_is_allowed(self):
        rows = [self.row('o-a', '2:19', ['chart-card']), self.row('x0', 200, ['zoom-detail']), self.row('x1', 260, ['chart-card']), self.row('x2', 320, ['zoom-detail', 'chart-card'])]
        self.assertEqual(self.messages(self.setup_film(rows, events=('chart',))), [])

    def test_adjacent_moments_sharing_a_main_technique_fail(self):
        rows = [self.row('o-a', '2:19', ['chart-card']), self.row('x0', '2:40', ['chart-card'], 'c')]
        self.assertTrue(any('adjacent moments share' in m for m in self.messages(self.setup_film(rows, events=('chart',)))))

    def test_the_reference_set_share_is_judged_once_there_are_enough_moments(self):
        few = [self.row('o-a', 100, ['scatter-exit']), self.row('x0', 200, ['zoom-detail'])]
        self.assertEqual(self.messages(self.setup_film(few)), [])
        many = [self.row('o-a', 100, ['scatter-exit']), self.row('x0', 200, ['zoom-detail']), self.row('x1', 300, ['scatter-exit']), self.row('x2', 400, ['zoom-detail']), self.row('x3', 500, ['chart-card'])]
        self._t.cleanup()
        self.setUp()
        self.assertTrue(any('chapter-1 techniques appear in 2 of 5' in m for m in self.messages(self.setup_film(many))))

    def test_map_add_refuses_a_known_id_and_an_event_type_taken_by_another_technique(self):
        self.setup_film([])
        full = self.path('film/ledger')
        variety.map_add(full, 'sketch', ['sketchy'], False)
        self.assertIn('sketch', jsonio.read(os.path.join(full, 'technique-map.json'))['techniques'])
        with self.assertRaisesRegex(ValueError, 'already exists'):
            variety.map_add(full, 'sketch', ['other'], False)
        with self.assertRaisesRegex(ValueError, 'already mapped'):
            variety.map_add(full, 'renamed-scatter', ['scatter'], False)

    def test_the_newest_row_for_an_option_wins(self):
        ctx = self.setup_film([self.row('o-a', '2:19', ['chart-card']), self.row('o-a', '2:19', ['scatter-exit'])])
        self.assertEqual(self.messages(ctx), [])

    def test_the_commands_report_the_whole_ledger_declare_a_row_and_refuse_an_unknown_technique(self):
        from rendercheck import cli
        self.setup_film([self.row('o-a', 100, ['chart-card']), self.row('x0', 200, ['chart-card'])])
        full = self.path('film/ledger')
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(['variety', full, '--limits', LIMITS]), 1)      # adjacent moments share their main technique
        self.assertIn('adjacent moments share main technique "chart-card"', out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['declare', full, '--lane', 'b', '--option', 'x1', '--moment', '5:00', '--techniques', 'zoom-detail', '--kind', 'built']), 0)
        self.assertEqual(variety.ledger_rows(os.path.join(full, 'technique-ledger.jsonl'))['x1']['technique_ids'], ['zoom-detail'])
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(cli.main(['declare', full, '--lane', 'b', '--option', 'x2', '--moment', '6:00', '--techniques', 'typo', '--kind', 'built']), 2)
        self.assertIn('refused', err.getvalue())


class LedgerLock(Base):
    """A wrapper that holds the ledger's .ledger.lock exports FILM_LEDGER_LOCK_HELD to its child; declare and map-add must not wait on it again."""
    def setUp(self):
        super().setUp()
        import fcntl
        self.dir = self.path('ledger')
        os.makedirs(self.dir)
        with open(f'{self.dir}/technique-map.json', 'w') as f:
            json.dump({'techniques': {'t': {'event_types': []}}}, f)
        self.lock = open(f'{self.dir}/.ledger.lock', 'a')
        fcntl.flock(self.lock, fcntl.LOCK_EX)

    def tearDown(self):
        self.lock.close()
        super().tearDown()

    def child(self, env_extra, timeout):
        code = ('import sys; sys.path.insert(0, %r); from rendercheck.checks import variety; '
                'variety.declare(%r, "b", "x-1", "1:00", ["t"], "built")') % (DO_WORK, self.dir)
        env = {**{k: v for k, v in os.environ.items() if k != 'FILM_LEDGER_LOCK_HELD'}, **env_extra}
        return subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, timeout=timeout)

    def test_a_child_of_the_lock_holder_does_not_wait_and_a_stranger_still_does(self):
        held = self.child({'FILM_LEDGER_LOCK_HELD': os.path.realpath(f'{self.dir}/.ledger.lock')}, 30)
        self.assertEqual(held.returncode, 0, held.stderr.decode())
        with open(f'{self.dir}/technique-ledger.jsonl') as f:
            self.assertIn('x-1', f.read())
        with self.assertRaises(subprocess.TimeoutExpired):
            self.child({}, 3)

    def test_a_variable_naming_another_lock_does_not_skip_this_one(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.child({'FILM_LEDGER_LOCK_HELD': self.path('other.lock')}, 3)


class Devices(Base):
    def film(self, moments):
        """A tiny film: one built option per moment, each spec using the given event types."""
        base = self.path('film')
        for d in ('ledger', 'lane-b/specs-1', 'lane-b/previews-1'):
            os.makedirs(f'{base}/{d}', exist_ok=True)
        rows = []
        for k, types in enumerate(moments):
            oid = f'm{k}-1'
            rows.append({'lane': 'b', 'option_id': oid, 'moment_time': f'{k + 1}:00', 'technique_ids': ['t'], 'kind': 'built'})
            jsonio.write(f'{base}/lane-b/specs-1/{oid}.json', {'events': [{'type': t, 'id': 'x', 'at': 0.1} for t in types]})
        with open(f'{base}/ledger/technique-ledger.jsonl', 'w') as f:
            f.write('\n'.join(json.dumps(r) for r in rows) + '\n')
        jsonio.write(f'{base}/ledger/technique-map.json', {'techniques': {'t': {'event_types': []}}})
        write_video(f'{base}/lane-b/previews-1/m3-1.mp4', flat())
        return ctx_for(self.tmp, f'{base}/lane-b/previews-1/m3-1.mp4', jsonio.read(f'{base}/lane-b/specs-1/m3-1.json'))

    def test_a_device_in_a_fourth_moment_fails_and_a_fresh_one_passes(self):
        self.assertEqual(verdict(devices.run(self.film([['pause'], ['pause'], ['pause'], ['pause']]))), 'FAIL')
        self.assertEqual(verdict(devices.run(self.film([['pause'], ['pause'], ['pause'], ['cutout']]))), 'PASS')

    def test_a_declared_entrance_shared_with_the_next_moment_fails(self):
        ctx = self.film([['a'], ['b'], ['c'], ['d'], ['e']])
        jsonio.write(self.path('film/lane-b/specs-1/m4-1.json'), {'events': [{'type': 'e', 'enter': 'drop'}]})
        ctx.spec = {'events': [{'type': 'd', 'enter': 'drop'}]}
        jsonio.write(self.path('film/lane-b/specs-1/m3-1.json'), ctx.spec)
        fs = devices.run(ctx)
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('adjacent moment 5:00', fs[0].message)


class SideBalance(Base):
    def film(self, sides, mine):
        """Built options whose timelines put their one box on the given side, and a video (the last option) whose own box is on `mine`."""
        base = self.path('film')
        os.makedirs(f'{base}/ledger')
        x = {'left': [100, 100, 300, 300], 'right': [1600, 100, 1800, 300]}
        rows = []
        for k, side in enumerate(sides + [mine]):
            oid = f'm{k}-1'
            rows.append({'lane': 'b', 'option_id': oid, 'moment_time': k * 60, 'technique_ids': [], 'kind': 'built'})
            os.makedirs(f'{base}/lane-b/out-1/{oid}')
            jsonio.write(f'{base}/lane-b/out-1/{oid}/timeline.json', {'elements': [], 'sounds': [], 'boxes': [{'id': 'g', 't0': 0.0, 'box': x[side]}]})
        with open(f'{base}/ledger/technique-ledger.jsonl', 'w') as f:
            f.write('\n'.join(json.dumps(r) for r in rows) + '\n')
        os.makedirs(f'{base}/lane-b/previews-1')
        pv = f'{base}/lane-b/previews-1/m{len(sides)}-1.mp4'
        write_video(pv, flat())
        ctx = ctx_for(self.tmp, pv, {'events': []})
        ctx.timeline = jsonio.read(f'{base}/lane-b/out-1/m{len(sides)}-1/timeline.json')
        return ctx

    def test_one_side_for_most_of_the_options_fails_and_a_balanced_film_passes(self):
        ctx = self.film(['left', 'left', 'left', 'right'], 'left')
        fs = placement.side_balance(ctx, ctx.cfg['placement'])
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('on the left of the frame', fs[0].message)
        self._t.cleanup()
        self.setUp()
        ctx = self.film(['left', 'right', 'left', 'right', 'right'], 'left')
        self.assertEqual(placement.side_balance(ctx, ctx.cfg['placement']), [])

    def test_without_a_variety_section_there_is_no_side_balance(self):
        ctx = self.film(['left', 'left', 'left', 'left'], 'left')
        del ctx.cfg['variety']
        self.assertEqual(placement.side_balance(ctx, ctx.cfg['placement']), [])


class ReusedFootage(Base):
    def film(self, pick_text):
        base = self.path('film')
        os.makedirs(f'{base}/lane-b/previews-1', exist_ok=True)
        t = 254016000000

        def clip(i, start, dur, src):
            return {'id': i, 'item': 8, 'name': 'C1.MP4', 'start': start * t, 'duration': dur * t, 'source_in': src * t, 'speed': 1.0}

        jsonio.write(f'{base}/source-cut.fcproj', {'project': {'items': {'7': {'name': 'Source cut (graded)', 'kind': {'Sequence': {'video_tracks': [
            {'items': [clip(1, 0, 20, 20), clip(2, 100, 40, 0), clip(3, 140, 20, 20)]}]}}}}}})
        with open(f'{base}/lane-b/PICKS-1.md', 'w') as f:
            f.write(f'### 01 1:40 a moment (x-1)\n\n{pick_text}\n\n### 02 3:00 other (y-1)\n')
        pv = f'{base}/lane-b/previews-1/x-1.mp4'
        write_video(pv, flat())
        reused_footage._CACHE.clear()
        return ctx_for(self.tmp, pv, {'edit': {'preview': [140, 150]}})

    def test_footage_the_cut_plays_twice_must_be_said_with_the_other_time(self):
        self.assertEqual(verdict(reused_footage.run(self.film('A plain description.'))), 'FAIL')
        self.assertEqual(verdict(reused_footage.run(self.film('This is the same footage the film opens with at 0:00.'))), 'PASS')

    def test_no_pick_section_is_not_measured_and_unrepeated_footage_is_an_empty_set(self):
        ctx = self.film('x')
        os.remove(self.path('film/lane-b/PICKS-1.md'))
        self.assertEqual(verdict(reused_footage.run(ctx)), 'WARN')
        ctx.edit['preview'] = [105, 120]
        self.assertTrue(reused_footage.run(ctx)[0].data.get('empty_set'))


class LabelTime(Base):
    def film(self, moment, start=100.0):
        base = self.path('film')
        for d in ('ledger', 'lane-b/previews-1'):
            os.makedirs(f'{base}/{d}', exist_ok=True)
        with open(f'{base}/ledger/technique-ledger.jsonl', 'w') as f:
            f.write(json.dumps({'lane': 'b', 'option_id': 'x-1', 'moment_time': moment, 'technique_ids': [], 'kind': 'built'}) + '\n')
        jsonio.write(f'{base}/ledger/technique-map.json', {'techniques': {}})
        pv = f'{base}/lane-b/previews-1/x-1.mp4'
        write_video(pv, flat())
        return ctx_for(self.tmp, pv, {'edit': {'preview': [start, start + 10]}})

    def test_a_label_inside_the_video_range_passes_and_one_outside_fails(self):
        self.assertEqual(verdict(label_time.run(self.film('1:40'))), 'PASS')      # the video plays 100 to 110 s
        self.assertEqual(verdict(label_time.run(self.film('1:45'))), 'PASS')      # a lead-in before the moment is fine
        bad = label_time.run(self.film('1:30', 105.0))
        self.assertEqual(verdict(bad), 'FAIL')
        self.assertIn('1:30', bad[0].message)
        self.assertEqual(verdict(label_time.run(self.film('2:00'))), 'FAIL')

    def test_watch_file_and_pick_heading_labels_are_read_too(self):
        ctx = self.film('1:40')
        watch = self.path('film/lane-b/1 - watch these')
        os.makedirs(watch)
        os.link(ctx.preview, f'{watch}/01 1m55 a moment - A.mp4')
        whole = self.path('film/WHOLE VIDEO 1')
        os.makedirs(whole)
        os.link(ctx.preview, f'{whole}/01 1:41 a moment.mp4')
        with open(self.path('film/lane-b/PICKS-1.md'), 'w') as f:
            f.write('### 01 1:40 a moment (x-1)\n')
        found = dict(label_time.labels(ctx, 'x-1'))
        self.assertEqual(sorted(found.values()), [100, 100, 101, 115])


class ReviewPack(Base):
    def test_a_pack_holds_contact_sheets_a_transcript_and_only_the_rules_of_its_kind(self):
        from rendercheck import cli
        from rendercheck.ctx import Context
        os.makedirs(self.path('videos'))
        write_video(self.path('videos/v-1.mp4'), flat(FPS * 2))
        cache = self.path('cache')
        words = [{'w': 'Pebbles', 's': 0.1, 'e': 0.4}, {'w': 'float.', 's': 0.4, 'e': 0.8}, {'w': 'Mostly.', 's': 1.2, 'e': 1.6}]
        jsonio.write(Context(self.path('videos/v-1.mp4'), {}, jsonio.read(LIMITS), cache_dir=cache)._words_cache_path(), words)
        jsonio.write(self.path('rules.json'), {'rows': [{'id': 'r-cut', 'rule': 'No cut lands inside a word.', 'kinds': ['film-edit']},
                                                        {'id': 'r-copy', 'rule': 'Copy is plain.', 'kinds': ['copy']}]})
        with contextlib.redirect_stdout(io.StringIO()):
            rc = cli.main(['review-pack', self.path('videos'), '--out', self.path('packs'), '--rules', self.path('rules.json'), '--limits', LIMITS, '--cache-dir', cache])
        self.assertEqual(rc, 0)
        pack = self.path('packs/v-1')
        self.assertTrue(os.path.isfile(f'{pack}/sheet-01.jpg'))
        with open(f'{pack}/transcript.txt') as f:
            self.assertEqual(f.read(), '00:00 Pebbles float.\n00:01 Mostly.\n')
        with open(f'{pack}/rules.txt') as f:
            self.assertEqual(f.read(), '- r-cut: No cut lands inside a word.\n')


if __name__ == '__main__':
    unittest.main()
