"""Every command of generate-and-judge-sound-effects run for real on made-up sounds and pages.

The sounds are tones written here; earshot is the stand-in in test/stubs (match z is how close a file's brightest
frequency is to the one its description names), put first on the commands' PYTHONPATH. The two library searches and
the fetcher read made-up pages through a stand-in urllib.request.urlopen. Needs numpy, soundfile and ffmpeg; skips
and says why without them.
"""
import io
import json
import os
import pathlib
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
DO_WORK = HERE.parent / 'do-work'
try:
    import numpy as np
    import soundfile as sf
    HAVE, WHY = shutil.which('ffmpeg') is not None, 'needs ffmpeg'
except ImportError as e:  # pragma: no cover
    HAVE, WHY = False, f'needs numpy and soundfile ({e})'

SR = 48000
FMT = {'rate': SR, 'channels': 2, 'fade_in_s': 0.005, 'fade_out_s': 0.02, 'peak_dbfs': -6.0}


def tone(path, hz, seconds=0.5, level=0.5, lead=0.1, tail=0.1, rise=None, channels=1):
    """a tone of `seconds` between `lead` and `tail` seconds of silence; rise = seconds it grows from silence to its peak"""
    t = np.arange(int(seconds * SR)) / SR
    x = level * np.sin(2 * np.pi * hz * t)
    if rise:
        x *= np.clip(t / rise, 0, 1) * np.where(t > rise, np.exp(-(t - rise) * 20), 1)
    x = np.concatenate([np.zeros(int(lead * SR)), x, np.zeros(int(tail * SR))])
    sf.write(path, np.repeat(x[:, None], channels, 1), SR, subtype='PCM_24' if level < 1 else 'FLOAT')
    return str(path)


def command(script, *args, expect=0):
    """run a do-work command with the stand-in earshot; its last line parsed"""
    env = {**os.environ, 'PYTHONPATH': str(HERE / 'stubs')}
    run = subprocess.run([sys.executable, str(DO_WORK / script), *map(str, args)], capture_output=True, text=True, env=env)
    if run.returncode != expect:
        raise AssertionError(f'{script} exit {run.returncode}\n{run.stdout}\n{run.stderr}')
    return json.loads(run.stdout.strip().splitlines()[-1])


@unittest.skipUnless(HAVE, WHY)
class Judge(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        for folder in ('forge/hit-impact', 'gen/model/hit', 'gen/model/hit-b', 'palette'):
            (self.dir / folder).mkdir(parents=True)
        self.low = tone(self.dir / 'forge/hit-impact/impact_01.wav', 200)
        self.high = tone(self.dir / 'forge/hit-impact/impact_02.wav', 2000)
        self.clipped = tone(self.dir / 'gen/model/hit/p0-s1.wav', 200, level=1.5)
        self.low2 = tone(self.dir / 'gen/model/hit/p0-s2.wav', 210)
        tone(self.dir / 'gen/model/hit-b/p0-s1.wav', 205)
        for name in ('hit', 'hit-b'):
            tone(self.dir / 'palette' / f'{name}.wav', 200, level=0.1, channels=2)
        (self.dir / 'model.jsonl').write_text(json.dumps({'file': self.low2, 'prompt': 'a low thud', 'seed': 2}) + '\n')

    def tearDown(self):
        shutil.rmtree(self.dir)

    def request(self, **over):
        req = {'sounds': [{'name': 'hit', 'query': 'a low hit'}], 'palette': FMT, 'reference_folder': str(self.dir / 'palette'),
               'candidates': {'forge': str(self.dir / 'forge/{group}-*/*.wav'), 'model': str(self.dir / 'gen/model/{sound}/*.wav')},
               'group_of': {'hit': 'hit', 'hit-b': 'hit'}, 'about': [str(self.dir / 'model.jsonl')], 'max_saturated': 0.001,
               'least_build': 0.8, 'candidates_folder': str(self.dir / 'cand'), 'picked_folder': str(self.dir / 'picked'),
               'scores': str(self.dir / 'candidates.json'), 'selection': str(self.dir / 'selection.json'), **over}
        path = self.dir / 'request.json'
        path.write_text(json.dumps(req))
        return path

    def test_picks_the_best_match_that_is_not_distorted_and_levels_it_to_the_reference(self):
        answer = command('judge_sound_effects.py', self.request())['result']
        self.assertEqual(answer['picks']['hit']['generator'], 'forge')
        picks = json.loads((self.dir / 'selection.json').read_text())
        self.assertEqual(picks['hit']['source'], self.low)
        rows = json.loads((self.dir / 'candidates.json').read_text())
        self.assertEqual(len(rows), 4)
        self.assertGreater(next(r for r in rows if r['source'] == self.clipped)['saturated_frac'], 0.001)
        self.assertEqual(next(r for r in rows if r['source'] == self.low2)['seed'], 2, 'the generator log is carried')
        y, rate = sf.read(self.dir / 'picked' / 'hit.wav', always_2d=True)
        ref, _ = sf.read(self.dir / 'palette' / 'hit.wav', always_2d=True)
        active = lambda a: float(np.sqrt(np.mean(a[np.abs(a).max(1) > np.abs(a).max() * 10 ** (-1.5)] ** 2)))  # noqa: E731
        self.assertEqual((rate, y.shape[1]), (SR, 2))
        self.assertAlmostEqual(active(y), active(ref), places=3)
        self.assertEqual(set(picks['hit']['best_by_generator']), {'forge', 'model'})
        self.assertIn('ab_summary', picks['hit'])

    def test_a_sound_never_takes_the_source_another_sound_picked_and_one_sound_is_judged_again(self):
        req = self.request(sounds=[{'name': 'hit', 'query': 'a low hit'}, {'name': 'hit-b', 'query': 'a low hit'}],
                           candidates={'forge': str(self.dir / 'forge/{group}-*/*.wav')}, not_from_pick_of={'hit-b': 'hit'})
        command('judge_sound_effects.py', req)
        picks = json.loads((self.dir / 'selection.json').read_text())
        self.assertEqual(picks['hit']['source'], self.low)
        self.assertEqual(picks['hit-b']['source'], self.high)
        again = command('judge_sound_effects.py', req, 'hit-b')['result']
        self.assertEqual(set(again['picks']), {'hit', 'hit-b'}, 'the sounds not named keep their picks')

    def test_lead_in_and_whole_trim(self):
        riser = tone(self.dir / 'forge/hit-impact/riser_03.wav', 200, seconds=1.0, rise=0.8)
        tone(self.dir / 'palette' / 'hit.wav', 200, seconds=0.6, rise=0.4, channels=2)
        command('judge_sound_effects.py', self.request(lead_in=['hit'], whole=['hit'], candidates={'forge': str(self.dir / 'forge/{group}-*/*.wav')}))
        rows = json.loads((self.dir / 'candidates.json').read_text())
        self.assertTrue(rows and all(r['trim_how'] == 'whole+lead-in' for r in rows))
        self.assertEqual(json.loads((self.dir / 'selection.json').read_text())['hit']['source'], riser)

    def test_the_tuned_values_come_from_the_settings_record_and_the_request_wins(self):
        record = self.dir / 'setting.json'
        tuned = {'sounds': [{'name': 'hit', 'query': 'a high hit'}], 'max_saturated': 0.001, 'least_build': 0.8, 'palette': FMT}
        row = lambda scope, values, status='active': {'id': f'record:setting:generate-and-judge-sound-effects~{scope}', 'type': 'record:setting',  # noqa: E731
                                                       'value': {'name': 'sound-effect judging', 'tool': 'tool:judge-sound-effect-candidates-and-pick-one-per-sound',
                                                                 'scope_kind': scope.split('~')[0], 'scope_id': scope.split('~')[1],
                                                                 'settings': json.dumps(values, sort_keys=True), 'from': 'made-up', 'status': status}}
        low = dict(tuned, sounds=[{'name': 'hit', 'query': 'a low hit'}])
        record.write_text(json.dumps([row('person~me', low), row('film~a-film', tuned)]))
        req = self.request()
        for key in ('sounds', 'max_saturated', 'least_build', 'palette'):
            req_value = json.loads(req.read_text())
            del req_value[key]
            req.write_text(json.dumps(req_value))
        req_value.update(settings_record=str(record), film='a-film')
        req.write_text(json.dumps(req_value))
        self.assertEqual(command('judge_sound_effects.py', req)['result']['picks']['hit']['generator'], 'forge')
        self.assertEqual(json.loads((self.dir / 'selection.json').read_text())['hit']['source'], self.high, 'the film\'s row says high')
        req.write_text(json.dumps({k: v for k, v in req_value.items() if k != 'film'}))
        command('judge_sound_effects.py', req)
        self.assertEqual(json.loads((self.dir / 'selection.json').read_text())['hit']['source'], self.low, 'with no film, the person\'s row says low')
        record.write_text(json.dumps([row('person~me', low, status='retired')]))
        self.assertIn('settings record could not be read', command('judge_sound_effects.py', req, expect=2)['error'])
        record.write_text(json.dumps({'id': 'record:setting:another-tool~person~me', 'type': 'record:setting', 'value': {'settings': '{}'}}))
        self.assertIn('holds no generate-and-judge-sound-effects row', command('judge_sound_effects.py', req, expect=2)['error'])

    def test_no_clean_candidate_is_a_named_refusal(self):
        answer = command('judge_sound_effects.py', self.request(candidates={'model': str(self.dir / 'gen/model/hit/p0-s1.wav')}), expect=2)
        self.assertIn('none of its 1 candidates is clean', answer['error'])


@unittest.skipUnless(HAVE, WHY)
class ListenAndPalette(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        (self.dir / 'hits').mkdir()
        self.low = tone(self.dir / 'hits' / 'a.wav', 200)
        self.high = tone(self.dir / 'hits' / 'b.wav', 2000)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_rank_then_whole_listening(self):
        cats = self.dir / 'categories.json'
        cats.write_text(json.dumps({'hit': {'folder': str(self.dir / 'hits'), 'query': 'a low hit', 'kind': 'event', 'top': 1, 'alts': ['a door']}}))
        out = self.dir / 'listen.json'
        self.assertEqual(command('listen_to_sound_effects.py', cats, out)['result']['categories'], 1)
        heard = json.loads(out.read_text())
        self.assertEqual([c['file'] for c in heard['hit']['candidates']], [self.low])
        self.assertLessEqual(heard['hit']['candidates'][0]['tail_db'], -30, 'the trim is moved out until its edge is clean')
        whole = self.dir / 'whole.json'
        command('listen_to_whole_sounds.py', whole, 'a high blip', 'a door|a knock', self.high)
        row = json.loads(whole.read_text())[f'{self.high}::a high blip']
        self.assertAlmostEqual(row['trim'][0], 0.1 - 0.005, places=3)
        self.assertAlmostEqual(row['trim'][1], 0.6 + 0.010, places=2)

    def test_made_palette_passes_its_check_and_an_unlicensed_or_short_one_fails(self):
        spec = {**FMT, 'sounds': [{'name': 'hit', 'src': 'hits/a.wav', 'trim': [0.05, 0.65], 'query': 'a low hit', 'manifest': 'lib-1'}]}
        palette = self.dir / 'palette.json'
        palette.write_text(json.dumps(spec))
        made = command('make_sound_palette.py', palette, self.dir, self.dir / 'palette')['result']
        self.assertEqual(json.loads(pathlib.Path(made['readings']).read_text())[0]['seconds'], 0.6)
        manifest = self.dir / 'manifest.json'
        manifest.write_text(json.dumps({'lib-1': {'file': 'x.wav'}}))
        bed = tone(self.dir / 'bed.wav', 300, seconds=2, channels=2)
        self.assertTrue(command('check_sound_palette.py', palette, self.dir / 'palette', manifest, 2, bed)['result']['passed'])
        self.assertEqual(command('check_sound_palette.py', palette, self.dir / 'palette', manifest, 5, bed, expect=1)['result']['failed'], [bed])
        manifest.write_text(json.dumps({'lib-1': {'file': None, 'blocked': 'not CC0'}}))
        self.assertEqual(command('check_sound_palette.py', palette, self.dir / 'palette', manifest, expect=1)['result']['failed'], ['licensed'])


@unittest.skipUnless(HAVE, WHY)
class Music(unittest.TestCase):
    def test_the_window_that_follows_the_arc_wins_and_is_listened_to(self):
        d = pathlib.Path(tempfile.mkdtemp())
        try:
            t = np.arange(40 * SR) / SR
            loud = np.interp(t, [0, 10, 20, 25, 30, 40], [0.02, 0.02, 0.02, 0.4, 0.05, 0.05])
            sf.write(d / 'track.wav', (loud * np.sin(2 * np.pi * 220 * t))[:, None], SR)
            brief = d / 'brief.json'
            brief.write_text(json.dumps({'arc': [[0, -12], [5, 0], [10, -6]], 'length_s': 10, 'open': [0, 2], 'lift': [4, 6], 'swell': [4, 6],
                                         'sections': [{'name': 'open', 'start': 0, 'end': 5, 'query': 'calm low pad'}], 'alts': ['rock'],
                                         'reference': {'stem': str(d / 'track.wav'), 'sections': [[0, 5], [5, 10]]}}))
            command('find_music_windows.py', brief, d / 'out', d / 'track.wav')
            windows = json.loads((d / 'out' / 'music' / 'windows.json').read_text())['windows']
            self.assertAlmostEqual(windows[0]['start_s'], 19.0, delta=1.5)
            self.assertTrue(pathlib.Path(windows[0]['excerpt']).is_file())
            command('listen_to_music_windows.py', brief, d / 'out')
            heard = json.loads((d / 'out' / 'music' / 'listen.json').read_text())
            self.assertEqual(list(heard[0]['sections']), ['open'])
            self.assertEqual(sorted(p.name for p in (d / 'out' / 'music' / 'ref-sections').iterdir()), ['reference-section1_0-5.wav', 'reference-section2_5-10.wav'])
        finally:
            shutil.rmtree(d)


@unittest.skipUnless(HAVE, WHY)
class EffectsLayer(unittest.TestCase):
    """The cues of a cue plan placed into an effects layer, a variant palette brought to the reference layer's loudness,
    and each variant scored at every cue."""
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        for folder in ('a', 'b'):
            (self.dir / folder).mkdir()
        tone(self.dir / 'a' / 'hit.wav', 200, seconds=0.3, level=0.4, lead=0, tail=0, channels=2)
        tone(self.dir / 'a' / 'tick.wav', 2000, seconds=0.05, level=0.4, lead=0, tail=0, channels=2)
        tone(self.dir / 'b' / 'hit.wav', 210, seconds=0.3, level=0.1, lead=0, tail=0, channels=2)
        tone(self.dir / 'b' / 'tick.wav', 1900, seconds=0.05, level=0.1, lead=0, tail=0, channels=2)
        self.cues = self.dir / 'cues.json'
        self.cues.write_text(json.dumps({'DUR': 3.0, 'cues': [[0.5, 'hit', 0.0], [1.0005, 'tick', -6.0], [2.0, 'hit', -3.0]]}))

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_cues_are_placed_at_whole_milliseconds_with_their_gain_and_summed(self):
        answer = command('place_cues_into_an_effects_layer.py', self.dir / 'a', self.cues, self.dir / 'a-layer.wav')['result']
        y, rate = sf.read(self.dir / 'a-layer.wav', always_2d=True)
        self.assertEqual((rate, len(y), y.shape[1]), (SR, 3 * SR, 2))
        self.assertEqual(float(np.abs(y[:int(0.5 * SR)]).max()), 0.0, 'nothing before the first cue')
        self.assertEqual(float(np.abs(y[int(0.9 * SR):SR]).max()), 0.0, 'the 1.0005 s cue is placed at 1.000 s, not before')
        self.assertGreater(float(np.abs(y[SR + 1]).max()), 0.0, 'and plays from there (a sine starts at zero)')
        self.assertAlmostEqual(float(np.abs(y[int(2.0 * SR):int(2.3 * SR)]).max()), 0.4 * 10 ** (-3 / 20), places=3)
        self.assertLess(answer['lufs'], 0)

    def test_a_variant_palette_gets_one_common_gain_to_the_reference_layers_loudness(self):
        command('place_cues_into_an_effects_layer.py', self.dir / 'a', self.cues, self.dir / 'a-layer.wav')
        level = command('match_an_effects_layer_loudness.py', self.dir / 'b', self.cues, self.dir / 'a-layer.wav')['result']
        self.assertAlmostEqual(level['common_gain_db'], 12.04, delta=0.3)
        self.assertEqual(json.loads((self.dir / 'b' / 'level.json').read_text()), level)
        after = command('place_cues_into_an_effects_layer.py', self.dir / 'b', self.cues, self.dir / 'b-layer.wav')['result']
        self.assertAlmostEqual(after['lufs'], level['target_lufs'], delta=0.2)

    def test_each_variant_is_scored_at_every_cue_on_its_layer_and_in_its_mix(self):
        command('place_cues_into_an_effects_layer.py', self.dir / 'a', self.cues, self.dir / 'a-layer.wav')
        request = self.dir / 'score.json'
        request.write_text(json.dumps({'picture': str(self.dir / 'picture.mp4'), 'cues': str(self.cues), 'palette': str(self.dir / 'a'),
                                       'sounds': [{'name': 'hit', 'query': 'a low hit'}, {'name': 'tick', 'query': 'a high tick'}],
                                       'scores': str(self.dir / 'scores.json')}))
        layer = self.dir / 'a-layer.wav'
        answer = command('score_soundtrack_variants.py', request, f'A={layer},{layer}')['result']
        scores = json.loads((self.dir / 'scores.json').read_text())
        self.assertEqual([c['sound'] for c in scores['A']['cues']], ['hit', 'tick', 'hit'])
        self.assertEqual(scores['A']['cue_z_by_sound']['hit']['n'], 2)
        self.assertGreater(scores['A']['cue_z_by_sound']['hit']['layer_median'], 2.5, 'the hit is heard as low where it plays')
        self.assertEqual(answer['variants']['A']['cue_z_layer_median'], scores['A']['cue_z_layer_median'])
        command('score_soundtrack_variants.py', request, f'B={layer},{layer}')
        self.assertEqual(sorted(json.loads((self.dir / 'scores.json').read_text())), ['A', 'B'], 'each variant is merged in')


FREESOUND_PAGE = (
    '<div class="bw-player" data-sound-id="12345" data-username="maker_a" data-user-id="77" data-title="Soft &amp; tick" '
    'data-duration="0.4567" data-num-downloads="900"></div>'
    '<div class="bw-player" data-sound-id="12345" data-username="maker_a" data-user-id="77" data-title="again" data-duration="0.4" data-num-downloads="1"></div>'
    '<div class="bw-player" data-title="no id"></div>')
MIXKIT_PAGE = (
    '<div data-audio-player-item-id-value="501"> <h2 class="item-grid-card__title"> Small click </h2> <span data-test-id="duration"> 0:01 </span></div>'
    '<div data-audio-player-item-id-value="502"> <h2 class="item-grid-card__title"> Long hum </h2> <span data-test-id="duration"> 1:05 </span></div>')
ITEM_PAGE_CC0 = ('<a title="Go to the full license text" href="http://creativecommons.org/publicdomain/zero/1.0">Creative Commons 0</a>'
                 '<div id="soundDescriptionSection"><p>A soft <b>tick</b>.</p></div>')
ITEM_PAGE_NC = '<a title="Go to the full license text" href="https://creativecommons.org/licenses/by-nc/4.0/">Attribution NonCommercial</a>'


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def run_with_pages(script, argv, pages):
    """run a do-work script in this process with urlopen answering from `pages` (a function of the address) and no waits"""
    real_open, real_sleep, real_argv = urllib.request.urlopen, __import__('time').sleep, sys.argv
    seen = []

    def urlopen(req, timeout=None):
        seen.append(req.full_url)
        body = pages(req.full_url)
        if body is None:
            raise urllib.error.HTTPError(req.full_url, 404, 'gone', {}, io.BytesIO())
        return Answer(body if isinstance(body, bytes) else body.encode())
    urllib.request.urlopen, sys.argv = urlopen, [script, *map(str, argv)]
    __import__('time').sleep = lambda s: None
    out = io.StringIO()
    real_stdout, sys.stdout = sys.stdout, out
    try:
        runpy.run_path(str(DO_WORK / script), run_name='__main__')
    finally:
        urllib.request.urlopen, sys.argv, sys.stdout = real_open, real_argv, real_stdout
        __import__('time').sleep = real_sleep
    return json.loads(out.getvalue().strip().splitlines()[-1]), seen


class FreeLibraries(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_freesound_and_mixkit_searches_keep_each_item_once_within_its_length(self):
        q = self.dir / 'fs.json'
        q.write_text(json.dumps({'tick': {'queries': ['soft tick'], 'max_s': 1.0}}))
        answer, seen = run_with_pages('search_freesound.py', [q, self.dir / 'fs-out.json'], lambda url: FREESOUND_PAGE)
        self.assertEqual(answer['result']['counts'], {'tick': 1})
        self.assertEqual(len(seen), 2, 'one page per licence filter')
        self.assertIn('duration%3A%5B0+TO+1.0%5D', seen[0])
        item = json.loads((self.dir / 'fs-out.json').read_text())['tick'][0]
        self.assertEqual((item['id'], item['title'], item['duration_s'], item['preview_hq_mp3']),
                         (12345, 'Soft & tick', 0.457, 'https://cdn.freesound.org/previews/12/12345_77-hq.mp3'))
        q.write_text(json.dumps({'tick': {'tags': ['click', 'gone'], 'max_s': 2}}))
        answer, seen = run_with_pages('search_mixkit.py', [q, self.dir / 'mk-out.json'], lambda url: MIXKIT_PAGE if 'click' in url else None)
        self.assertEqual(answer['result']['counts'], {'tick': 1}, 'the long one is left out; a missing tag page is skipped')
        self.assertEqual(json.loads((self.dir / 'mk-out.json').read_text())['tick'][0]['wav_url'], 'https://assets.mixkit.co/active_storage/sfx/501/501.wav')

    def test_fetch_keeps_allowed_licences_only_and_says_why_not(self):
        fs = {'tick': [{'id': 1, 'title': 'Tick one', 'user': 'maker_a', 'page': 'https://fs.test/1/', 'preview_hq_mp3': 'https://fs.test/1.mp3'},
                       {'id': 2, 'title': 'Tick two', 'user': 'maker_b', 'page': 'https://fs.test/2/', 'preview_hq_mp3': 'https://fs.test/2.mp3'}]}
        mk = {'tick': [{'id': 9, 'title': 'Click', 'tag_page': 'https://mk.test/click/', 'wav_url': 'https://mk.test/9.wav'},
                       {'id': 8, 'title': 'Gone', 'tag_page': 'https://mk.test/click/', 'wav_url': 'https://mk.test/8.wav'}]}
        (self.dir / 'fs.json').write_text(json.dumps(fs))
        (self.dir / 'mk.json').write_text(json.dumps(mk))
        sel = self.dir / 'selection.json'
        sel.write_text(json.dumps({'tick': [['freesound', 1], ['freesound', 2], ['mixkit', 9], ['mixkit', 8]]}))
        served = {'https://fs.test/1/': ITEM_PAGE_CC0, 'https://fs.test/2/': ITEM_PAGE_NC, 'https://fs.test/1.mp3': b'ID3 one', 'https://mk.test/9.wav': b'RIFF nine'}
        argv = [sel, self.dir / 'fs.json', self.dir / 'mk.json', self.dir / 'sfx', self.dir / 'manifest.json']
        answer, _ = run_with_pages('fetch_free_sound_effects.py', argv, served.get)
        self.assertEqual({k: answer['result'][k] for k in ('kept', 'blocked', 'unavailable')}, {'kept': 2, 'blocked': 1, 'unavailable': 1})
        manifest = json.loads((self.dir / 'manifest.json').read_text())
        self.assertEqual(manifest['freesound-1']['licence'], 'CC0 1.0')
        self.assertEqual(manifest['freesound-1']['description'], 'A soft tick .')
        self.assertEqual(pathlib.Path(manifest['freesound-1']['file']).read_bytes(), b'ID3 one')
        self.assertIsNone(manifest['freesound-2']['file'])
        self.assertIn('NonCommercial', manifest['freesound-2']['blocked'])
        self.assertTrue(manifest['mixkit-9']['file'].endswith('tick/mk-9_click.wav'))
        self.assertIn('HTTP 404', manifest['mixkit-8']['unavailable'])
        _, seen = run_with_pages('fetch_free_sound_effects.py', argv, served.get)
        self.assertNotIn('https://fs.test/1.mp3', seen, 'a file already kept is not fetched again')


if __name__ == '__main__':
    unittest.main()
