"""The settings, the catalog, the lines in turns, the staging, the per-video sums, the caption-turn count, the voice finder
and its checks, and the show scripts, on the made-up show of fixture_world.py."""
import csv
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fixture_world import SETTINGS, catalog_file, json3, last, refused, run, setting_row, write  # noqa: E402

HAS_NUMPY = importlib.util.find_spec('numpy') is not None
HAS_SKLEARN = HAS_NUMPY and importlib.util.find_spec('sklearn') is not None
HAS_SETTINGS = os.path.exists(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                           'settings', 'read-data', 'settings.py'))


def table(path):
    return list(csv.DictReader(open(path), delimiter='\t', quoting=csv.QUOTE_NONE))


class World(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.data = os.path.join(self.dir, 'show')
        self.yt = os.path.join(self.dir, 'youtube')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def path(self, *parts):
        return os.path.join(self.dir, *parts)

    def ask(self, **fields):
        return {'data_folder': self.data, 'youtube_folder': self.yt, 'settings': SETTINGS, **fields}


class SettingsTest(World):
    def test_a_missing_or_wrong_key_is_refused_by_name(self):
        error = refused(run('do-work/count_terms.py', {'data_folder': self.data, 'youtube_folder': self.yt, 'settings': {}}))
        self.assertIn('terms is missing', error)
        error = refused(run('do-work/sum_per_video.py', {'data_folder': self.data, 'settings': {**SETTINGS, 'opening_seconds': 'five'}}))
        self.assertIn('opening_seconds must be a number', error)
        self.assertIn('needs data_folder', refused(run('do-work/measure_staging.py', {'ids': ['x'], 'youtube_folder': self.yt})))
        self.assertIn('not JSON', refused(run('do-work/measure_staging.py', 'not json')))

    @unittest.skipUnless(HAS_SETTINGS, 'needs tools/settings')
    def test_the_settings_row_is_read_by_the_one_reader(self):
        catalog_file(self.data)
        write(os.path.join(self.data, 'voice', 'vid-a.turns.json'), {'id': 'vid-a', 'duration_s': 100.0, 'character_s': 3.0, 'turns': [[50.0, 53.0]]})
        res = last(run('do-work/sum_per_video.py', {'data_folder': self.data, 'settings_record': setting_row()}))
        self.assertEqual(res['scored'], 1)
        row_file = write(self.path('row.json'), setting_row())
        self.assertEqual(last(run('do-work/sum_per_video.py', {'data_folder': self.data, 'settings_record': row_file}))['scored'], 1)
        # the request's own settings lie over the row's
        row = setting_row({**SETTINGS, 'opening_seconds': 'five'})
        self.assertEqual(last(run('do-work/sum_per_video.py', {'data_folder': self.data, 'settings_record': row,
                                                               'settings': {'opening_seconds': 20}}))['scored'], 1)
        film = setting_row({**SETTINGS, 'opening_seconds': 'five'})
        film['id'] = film['id'].replace('~piece~lighthouse-parrot', '~film~lighthouse')
        film['value'].update(scope_kind='film', scope_id='lighthouse')
        both = {'data_folder': self.data, 'settings_record': [film, setting_row()]}
        self.assertIn('opening_seconds must be a number', refused(run('do-work/sum_per_video.py', {**both, 'scopes': [{'kind': 'film', 'id': 'lighthouse'}]})))
        self.assertEqual(last(run('do-work/sum_per_video.py', {**both, 'scopes': [{'kind': 'piece', 'id': 'lighthouse-parrot'}, {'kind': 'film', 'id': 'lighthouse'}]}))['scored'], 1)
        self.assertIn('no scope', refused(run('do-work/sum_per_video.py', both)))
        self.assertIn('holds no row of tools/measure-a-characters', refused(run('do-work/sum_per_video.py', {
            'data_folder': self.data, 'settings_record': setting_row(folder='another-tool')})))
        self.assertIn('retired', refused(run('do-work/sum_per_video.py', {'data_folder': self.data, 'settings_record': setting_row(status='retired')})))
        self.assertIn('records:read', refused(run('do-work/sum_per_video.py', {'data_folder': self.data, 'settings_record': setting_row()['id']})))


class CatalogTest(World):
    def test_formats_follow_the_order_of_the_old_rules_and_the_baseline_rolls(self):
        write(os.path.join(self.yt, 'flat', 'lighthouse-videos.json'), {'entries': [
            {'id': 'vid-a', 'title': 'The Lighthouse Hour: Fog', 'duration': 1800, 'view_count': 1000, 'timestamp': 1893456000},
            {'id': 'vid-b', 'title': 'Behind the lamp: tools', 'duration': 600, 'view_count': 500, 'timestamp': 1893542400},
            {'id': 'vid-c', 'title': 'The Lighthouse Hour: Gulls', 'duration': 1700, 'view_count': 3000, 'timestamp': 1893628800},
            {'id': 'vid-d', 'title': 'Members night', 'duration': 900, 'view_count': None, 'timestamp': 1893715200},
            {'id': 'vid-e', 'title': 'The Lighthouse Hour: Rocks', 'duration': 1750, 'view_count': 2000},
            {'id': 'vid-f', 'title': 'Season trailer', 'duration': 900, 'view_count': 800},
            {'id': 'vid-g', 'title': 'Short wave', 'duration': 40, 'view_count': 700},
            {'id': 'vid-h', 'title': 'Best of the fog', 'duration': 4000, 'view_count': 0}]})
        write(os.path.join(self.yt, 'flat', 'lighthouse-shorts.json'), {'entries': [{'id': 'clip-a', 'title': 'Parrot!', 'duration': 20, 'view_count': 50}]})
        write(os.path.join(self.yt, 'comments', 'vid-a.info.json'), {'upload_date': '20300101', 'like_count': 40, 'comment_count': 7})
        os.makedirs(self.data)
        res = last(run('do-work/catalog_videos.py', self.ask(channel='lighthouse')))
        self.assertEqual(res['videos'], 9)
        rows = {r['id']: r for r in table(os.path.join(self.data, 'catalog.tsv'))}
        self.assertEqual({k: r['format'] for k, r in rows.items()},
                         {'vid-a': 'episode', 'vid-b': 'extra', 'vid-c': 'episode', 'vid-d': 'members-only', 'vid-e': 'episode',
                          'vid-f': 'side', 'vid-g': 'side', 'vid-h': 'compilation', 'clip-a': 'short'})
        self.assertEqual((rows['vid-a']['date'], rows['vid-a']['likes']), ('20300101', '40'))
        self.assertEqual(rows['vid-c']['date'], '20300103~')
        self.assertEqual(rows['vid-e']['date'], '')
        self.assertEqual((rows['vid-c']['baseline'], rows['vid-c']['x_baseline']), ('1500', '2.0'))   # median of a and e
        self.assertEqual(rows['vid-d']['x_baseline'], '')


class LinesTest(World):
    def test_a_line_counts_when_half_of_it_is_inside_a_turn(self):
        catalog_file(self.data)
        write(os.path.join(self.data, 'voice', 'vid-a.turns.json'), {'id': 'vid-a', 'duration_s': 60, 'character_s': 4, 'turns': [[10.0, 14.0]]})
        write(os.path.join(self.yt, 'videos', 'vid-a.en-orig.json3'), json3([(5, 4, 'the keeper speaks'), (9, 2, '>> crackers please'),
                                                                            (11.5, 2, 'and a storm'), (13.5, 3, 'back to the lamp')]))
        res = last(run('do-work/list_lines_in_turns.py', self.ask()))
        self.assertEqual(res['lines'], 2)
        self.assertEqual([(r['second'], r['text'], r['format']) for r in table(res['table'])],
                         [('9', '>> crackers please', 'episode'), ('11', 'and a storm', 'episode')])


class StagingTest(World):
    def test_cuts_shots_and_stopdowns_around_turns(self):
        write(os.path.join(self.data, 'voice', 'vid-a.turns.json'), {'id': 'vid-a', 'character_s': 6, 'turns': [[10.0, 12.0], [15.0, 17.0], [40.0, 42.0]]})
        shots = [{'start': 0, 'end': 9.8}, {'start': 9.8, 'end': 11.0}, {'start': 11.0, 'end': 12.0}, {'start': 12.0, 'end': 30.0},
                 {'start': 30.0, 'end': 60.0}]
        write(os.path.join(self.yt, 'measure', 'vid-a', 'rhythm.json'), {'seconds': 60, 'cuts_per_min': 4, 'shots': shots})
        write(os.path.join(self.yt, 'measure', 'vid-a', 'earshot-timeline.txt'), '  0:08.50  GAP drop music\n  0:39.00 GAP drop music\n  0:20.0 HIT\n')
        write(os.path.join(self.data, 'staging.tsv'), 'id\tturns\nvid-old\t3\n')
        res = last(run('do-work/measure_staging.py', self.ask(ids=['vid-a', 'vid-missing'])))
        self.assertEqual(res['measured'], ['vid-a'])
        rows = {r['id']: r for r in table(res['table'])}
        self.assertIn('vid-old', rows)
        r = rows['vid-a']
        self.assertEqual((r['turns'], r['character_s']), ('3', '6'))
        self.assertEqual(r['cut_at_entry_share'], '0.33')          # only the turn at 10 s has a cut within 0.5 s
        self.assertEqual(r['cut_chance_share'], '0.07')            # 4 cuts / 60 s
        self.assertEqual(r['median_shot_in_exchange_s'], '1.2')    # shots starting in [8, 19] and [38, 44]
        self.assertEqual(r['median_shot_elsewhere_s'], '19.9')
        self.assertEqual(r['stopdown_before_turn_share'], '0.67')  # stop-downs 1.5 s before 10 and 1 s before 40
        self.assertEqual(r['stopdown_chance_share'], '0.07')


class PerVideoTest(World):
    def test_opening_close_body_exchanges_and_the_stripped_ones(self):
        catalog_file(self.data)
        write(os.path.join(self.data, 'voice', 'vid-a.turns.json'), {'id': 'vid-a', 'duration_s': 100.0, 'character_s': 12.0,
                                                                     'turns': [[5.0, 8.0], [18.0, 22.0], [30.0, 31.0], [35.0, 36.0], [60.0, 61.0], [95.0, 97.0]]})
        write(os.path.join(self.data, 'voice', 'vid-c.turns.json'), {'id': 'vid-c', 'duration_s': 90.0, 'character_s': 1.0, 'turns': [[50.0, 51.0]]})
        proc = run('do-work/sum_per_video.py', self.ask())
        res = last(proc)
        self.assertEqual((res['scored'], res['episodes']), (2, 2))
        rows = {r['id']: r for r in table(res['table'])}
        a = rows['vid-a']
        self.assertEqual((a['open_s'], a['outro_s'], a['body_s'], a['body_exchanges']), ('5.0', '2.0', '3.0', '2'))
        self.assertEqual((a['median_gap_s'], a['ex_per_10min'], a['stripped']), ('24.0', '17.14', 'False'))
        self.assertEqual((rows['vid-c']['stripped'], rows['vid-c']['date'], rows['vid-c']['approx']), ('True', '20300301', 'True'))
        self.assertEqual((res['stripped_median'], res['full_median']), (0.5, 1.5))
        self.assertIn('low 0  | mid 0  | high 0', proc.stdout)      # no year has the six videos thirds need


@unittest.skipUnless(HAS_NUMPY, 'needs numpy')
class CaptionTurnsTest(World):
    def test_a_marked_turn_counts_when_its_pitch_is_high(self):
        import numpy as np
        catalog_file(self.data)
        t = np.arange(0, 60, 0.5)
        f0 = np.where((t >= 9.25) & (t < 13), 300.0, 110.0).astype(np.float32)
        os.makedirs(self.path('elsewhere'))
        np.savez_compressed(self.path('elsewhere', 'vid-a.emb.npz'), t=t, emb=np.zeros((len(t), 4)), f0=f0, rms=np.ones(len(t)),
                            keep=np.ones(len(t), bool))
        write(os.path.join(self.yt, 'captions', 'vid-a.en.json3'), json3([(2, 3, '>> keeper: fog today'), (10, 2, '>> crackers'),
                                                                          (14, 2, '>> back to fog'), (20, 2, '>> more fog'), (22, 2, '>> gulls'),
                                                                          (30, 2, 'and the rocks')]))
        res = last(run('do-work/count_caption_turns.py', self.ask(extra_voice_folders=[self.path('elsewhere')])))
        self.assertEqual(res['videos'], 1)
        r = table(res['table'])[0]
        self.assertEqual((r['caption_turns'], r['character_turns'], r['character_s'], r['episode_median_f0']), ('5', '1', '4.0', '110.0'))
        res = last(run('do-work/count_caption_turns.py', self.ask(extra_voice_folders=[self.path('elsewhere')], ratio=3)))
        self.assertEqual(table(res['table'])[0]['character_turns'], '0')


def voice_world(test, np):
    """Two made-up recordings: windows every 0.5 s whose 8-number embeddings point one way for the parrot (high pitch)
    and another for the keeper; a third high voice (a guest) points a third way."""
    rng = np.random.default_rng(7)
    parrot, keeper, guest = np.eye(8)[0], np.eye(8)[1], np.eye(8)[2]
    for name, spans in (('rec-a', [(10, 14), (30, 33)]), ('rec-b', [(5, 9)])):
        t = np.arange(0, 40, 0.5)
        mid = t + 0.75
        is_parrot = np.zeros(len(t), bool)
        for a, b in spans:
            is_parrot |= (mid >= a) & (mid < b)
        is_guest = (mid >= 20) & (mid < 23)
        f0 = np.where(is_parrot, 320.0, np.where(is_guest, 300.0, 110.0)).astype(np.float32)
        emb = np.where(is_parrot[:, None], parrot, np.where(is_guest[:, None], guest, keeper)) + rng.normal(0, 0.05, (len(t), 8))
        emb[f0 < 200] = 0                                      # windows under the embed gate carry no embedding
        np.savez_compressed(os.path.join(test.data, 'voice', name + '.emb.npz'), t=t, emb=emb.astype(np.float32), f0=f0,
                            rms=np.ones(len(t), np.float32), keep=np.ones(len(t), bool))


@unittest.skipUnless(HAS_SKLEARN, 'needs numpy and scikit-learn')
class VoiceFinderTest(World):
    def setUp(self):
        super().setUp()
        import numpy as np
        os.makedirs(os.path.join(self.data, 'voice'))
        voice_world(self, np)
        npz = os.path.join(self.data, 'voice', 'rec-a.emb.npz')
        for label, spans in (('parrot', '10-14,30-33'), ('guest', '20-23')):
            last(run('do-work/find_voice.py', self.ask(step='seed', npz=npz, label=label, ranges=spans)))
        npz = os.path.join(self.data, 'voice', 'rec-b.emb.npz')
        last(run('do-work/find_voice.py', self.ask(step='seed', npz=npz, label='guest', ranges='20-23')))
        self.seeded = last(run('do-work/find_voice.py', self.ask(step='seed', npz=npz, label='parrot', ranges='5-9')))

    def test_seed_and_score_find_the_character_and_not_the_other_high_voice(self):
        self.assertEqual(self.seeded['counts'], {'guest': 8, 'parrot': 16})
        out = os.path.join(self.data, 'voice', 'rec-a.turns.json')
        res = last(run('do-work/find_voice.py', self.ask(step='score', npz=os.path.join(self.data, 'voice', 'rec-a.emb.npz'), json=out)))
        self.assertEqual((res['id'], res['turns']), ('rec-a', 2))
        turns = json.load(open(out))
        self.assertEqual(turns['turns'], [[10.0, 14.0], [30.0, 33.0]])
        self.assertEqual((turns['character_s'], turns['gate_hz']), (7.0, 176.0))   # 1.6 x the median 110 Hz

    def test_rescore_writes_every_recording_and_the_checks_leave_one_out(self):
        self.assertEqual(last(run('do-work/find_voice.py', self.ask(step='rescore')))['scored'], 2)
        self.assertTrue(os.path.exists(os.path.join(self.data, 'voice', 'rec-b.turns.json')))
        held = last(run('do-work/check_seed_model.py', self.ask()))
        self.assertEqual([r['recording'] for r in held], ['rec-a.emb.npz', 'rec-b.emb.npz'])
        self.assertEqual(sum(r['tp'] for r in held), 16)
        grid = last(run('do-work/check_voice_finder.py', self.ask(ratios=[1.6], cosines=[0.5])))
        self.assertEqual(len(grid), 2)
        self.assertTrue(all(r['fp'] == 0 for r in grid))

    def test_a_step_it_does_not_know_is_refused(self):
        self.assertIn('step is one of', refused(run('do-work/find_voice.py', self.ask(step='guess'))))


class ShowTest(World):
    def test_show_lines_turns_and_runs(self):
        cap = write(self.path('vid-a.en.json3'), json3([(1, 2, 'fog'), (5, 2, '>> crackers'), (9, 2, 'storm')]))
        proc = run('show/show_lines.py', None, cap, '4', '10')
        self.assertEqual(proc.stdout.splitlines(), ['    5.0 >> crackers', '    9.0 storm'])
        turns = write(self.path('vid-a.turns.json'), {'turns': [[4.5, 7.0], [8.0, 8.5]]})
        proc = run('show/show_turns.py', None, turns, cap, '1')
        self.assertEqual(proc.stdout.splitlines(), ['    4.5-    7.0   2.5s >> crackers'])
        runs = write(self.path('vid-a.json'), {'hi_runs': [{'start': 8.5, 'end': 10.0, 'f0_median': 301.2}]})
        proc = run('show/show_runs.py', None, runs, cap)
        self.assertEqual(proc.stdout.splitlines(), ['    8.5-   10.0   1.5s   301Hz  storm'])

    @unittest.skipUnless(HAS_NUMPY, 'needs numpy')
    def test_show_line_pitch(self):
        import numpy as np
        t = np.arange(0, 20, 0.5)
        f0 = np.where(t >= 4.5, 300.0, 110.0).astype(np.float32)
        os.makedirs(os.path.join(self.data, 'voice'))
        np.savez_compressed(os.path.join(self.data, 'voice', 'vid-a.emb.npz'), t=t, f0=f0)
        write(os.path.join(self.yt, 'captions', 'vid-a.en.json3'), json3([(1, 2, 'fog'), (5, 2, '>> crackers'), (9, 2, 'storm')]))
        proc = run('show/show_line_pitch.py', None, 'vid-a', '0', '6', self.data, self.yt)
        self.assertEqual(proc.stdout.splitlines(), ['    1.0-    5.0   110Hz  fog', '    5.0-    9.0   300Hz  >> crackers'])


if __name__ == '__main__':
    unittest.main()
