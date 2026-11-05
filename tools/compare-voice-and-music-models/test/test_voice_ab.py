"""Tests of the narration voice A/B scripts (say_a_line_in_kokoro.py, say_a_line_in_a_cloned_voice.py, measure_takes.py,
render_takes.sh) with made-up lines and code-made audio. The voice, speech-to-text, speaker and accent models are not
run: stand-ins answer in their shapes, so units, pauses, silence handling, best-of-N, the measures and every refusal are
tested for real."""
import importlib.util, json, os, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, '..', 'do-work')
FIX = os.path.join(HERE, 'fixtures')
LINE = os.path.join(FIX, 'narration-line.json')
sys.path.insert(0, WORK)
import say_a_line_in_kokoro as kt  # noqa: E402

HAVE = {name: importlib.util.find_spec(name) is not None for name in ('numpy', 'soundfile', 'mlx_audio', 'mlx_whisper', 'parselmouth')}
NODE = shutil.which('node')
STAND_IN = os.path.join(HERE, 'stand-in-settings-reader.mjs')
SR = 24000


def run(*args, env=None):
    done = subprocess.run(list(args), capture_output=True, text=True, env=env)
    return done, json.loads(done.stdout.strip().splitlines()[-1])


def write(path, text):
    with open(path, 'w') as f:
        f.write(text if isinstance(text, str) else json.dumps(text))


def read(path):
    with open(path) as f:
        return json.load(f)


def tone(seconds, sr=SR, f=220.0, level=0.3):
    import numpy as np
    t = np.arange(int(seconds * sr)) / sr
    return (level * np.sin(2 * np.pi * f * t)).astype(np.float32)


def hush(seconds, sr=SR):
    import numpy as np
    return np.zeros(int(seconds * sr), np.float32)


class Line(unittest.TestCase):
    def test_the_line_is_read(self):
        line = kt.read_line(LINE)
        self.assertEqual(len(line['units']), len(line['pause_after']))

    def test_bad_lines_are_refused(self):
        d = tempfile.mkdtemp()
        try:
            cases = [({'units': ['a'], 'pause_after': [0.1, 0.2], 'inner_most': 0.4, 'script': 'a'}, 'one pause_after per unit'),
                     ({'units': ['a', 'b'], 'pause_after': [0.1, 0.2], 'inner_most': [0.4], 'script': 'a b'}, 'one inner_most per unit'),
                     ({'units': ['a']}, 'has no pause_after, inner_most, script')]
            for i, (line, message) in enumerate(cases):
                path = os.path.join(d, f'{i}.json')
                write(path, line)
                with self.assertRaises(kt.Refusal) as caught:
                    kt.read_line(path)
                self.assertIn(message, str(caught.exception))
            with self.assertRaises(kt.Refusal) as caught:
                kt.read_line(os.path.join(d, 'absent.json'))
            self.assertIn('is not there', str(caught.exception))
        finally:
            shutil.rmtree(d)

    def test_lang_follows_the_voice_accent(self):
        self.assertEqual([kt.lang_of(v) for v in ('bm_lewis', 'af_heart', 'zf_xiaoyi')], ['b', 'a', 'b'])


@unittest.skipUnless(HAVE['numpy'], 'needs numpy')
class Silences(unittest.TestCase):
    def test_trim_keeps_20_ms_before_and_40_ms_after_the_sound(self):
        y = kt.trim(__import__('numpy').concatenate([hush(0.5), tone(1.0), hush(0.5)]), SR)
        self.assertAlmostEqual(len(y) / SR, 1.06, delta=0.012)

    def test_a_long_inner_silence_is_cut_to_inner_most_and_speech_is_kept(self):
        import numpy as np
        y = np.concatenate([tone(0.5), hush(1.2), tone(0.5)])
        capped = kt.cap_inner(y, SR, 0.45)
        self.assertAlmostEqual(len(capped) / SR, 1.0 + 0.45, delta=0.02)
        short = np.concatenate([tone(0.5), hush(0.3), tone(0.5)])
        self.assertEqual(len(kt.cap_inner(short, SR, 0.45)), len(short))

    def test_units_are_joined_by_their_set_pauses(self):
        line = {'units': ['a', 'b'], 'pause_after': [0.6, 0.0], 'inner_most': 0.45, 'script': 'a b'}
        y = kt.join([tone(0.5), tone(0.7)], line, SR)
        self.assertAlmostEqual(len(y) / SR, 0.5 + 0.6 + 0.7, delta=0.13)
        self.assertLess(float(abs(y[int(0.6 * SR):int(1.05 * SR)]).max()), 1e-6, 'the set pause is silence')


class FakeKokoro:
    sample_rate = SR

    def __init__(self):
        self.calls = []

    def generate(self, text, **kw):
        self.calls.append((text, kw))
        yield type('R', (), {'audio': tone(0.3 + 0.01 * len(text))})()


@unittest.skipUnless(HAVE['numpy'], 'needs numpy')
class SayInKokoro(unittest.TestCase):
    def test_each_unit_is_one_generation_with_the_voice_lang_and_speed(self):
        fake = FakeKokoro()
        y, sr = kt.say_line(kt.read_line(LINE), 'bm_george', kt.settings(), load_model=lambda name: fake)
        self.assertEqual(sr, 24000)
        self.assertEqual([t for t, _ in fake.calls], kt.read_line(LINE)['units'])
        self.assertEqual(fake.calls[0][1], {'voice': 'bm_george', 'speed': 1.0, 'lang_code': 'b', 'split_pattern': r'\n+'})
        self.assertGreater(len(y) / sr, 0.65 + 0.4)

    def test_refusals_come_before_any_model_loads(self):
        done, last = run(sys.executable, '-I', os.path.join(WORK, 'say_a_line_in_kokoro.py'))
        self.assertEqual(done.returncode, 2)
        self.assertIn('pass <line.json> <voice> <out.wav>', last['error'])
        done, last = run(sys.executable, '-I', os.path.join(WORK, 'say_a_line_in_kokoro.py'), '/nowhere.json', 'bm_lewis', '/tmp/x.wav')
        self.assertIn('is not there', last['error'])

    @unittest.skipIf(HAVE['mlx_audio'], 'mlx-audio is installed here')
    def test_without_mlx_audio_it_says_how_to_install(self):
        done, last = run(sys.executable, '-I', os.path.join(WORK, 'say_a_line_in_kokoro.py'), LINE, 'bm_lewis', os.path.join(tempfile.gettempdir(), 'x.wav'))
        self.assertEqual(done.returncode, 2)
        self.assertIn('pip install -U mlx-audio', last['error'])


class Settings(unittest.TestCase):
    def test_no_record_gives_the_defaults(self):
        self.assertEqual(kt.settings(), kt.DEFAULTS)
        self.assertIsNot(kt.settings()['takes'], kt.DEFAULTS['takes'])

    @unittest.skipUnless(NODE, 'needs node')
    def test_the_record_is_read_by_the_settings_reader_over_the_defaults(self):
        cfg = kt.settings(os.path.join(FIX, 'settings-row.json'), reader=STAND_IN)
        self.assertEqual(cfg['clone_takes'], 5)
        self.assertEqual(cfg['master_command'], '')
        self.assertEqual(cfg['kokoro_model'], kt.DEFAULTS['kokoro_model'])
        self.assertEqual(kt.take_rows(cfg), ['pocket|B pocket|say_a_line_in_a_cloned_voice.py pocket',
                                             'synthetic-601f4f805f94|A kokoro|say_a_line_in_kokoro.py af_heart'])

    @unittest.skipUnless(NODE, 'needs node')
    def test_a_record_the_reader_refuses_is_refused_with_its_reason(self):
        d = tempfile.mkdtemp()
        try:
            row = read(os.path.join(FIX, 'settings-row.json'))
            row['value']['status'] = 'retired'
            path = os.path.join(d, 'row.json'); write(path, row)
            with self.assertRaises(kt.Refusal) as caught:
                kt.settings(path, reader=STAND_IN)
            self.assertIn('retired', str(caught.exception))
        finally:
            shutil.rmtree(d)

    def test_a_missing_record_or_reader_is_refused(self):
        with self.assertRaises(kt.Refusal) as caught:
            kt.settings('/nowhere/row.json')
        self.assertIn('is not there', str(caught.exception))
        with self.assertRaises(kt.Refusal) as caught:
            kt.settings(os.path.join(FIX, 'settings-row.json'), reader='/nowhere/settings-record.mjs')
        self.assertIn('settings-record.mjs is not in this Workshop checkout', str(caught.exception))

    def test_take_rows_and_chain_are_what_render_takes_reads(self):
        rows = kt.take_rows(kt.settings())
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows[1], 'qwen3|3 Qwen3-TTS clone|say_a_line_in_a_cloned_voice.py qwen3')
        self.assertEqual(kt.chain(kt.settings()), ['', 'showtime voice master', '', ''])
        for bad in ({'work': 'x', 'name': 'y', 'maker': 'clone'}, {'work': 'a|b', 'name': 'y', 'maker': 'kokoro', 'voice': 'bm_lewis'}):
            with self.assertRaises(kt.Refusal):
                kt.take_rows({**kt.settings(), 'takes': [bad]})


import say_a_line_in_a_cloned_voice as ct  # noqa: E402


class Clone(unittest.TestCase):
    def test_markup_becomes_the_plain_word_and_errors_are_word_edits(self):
        self.assertEqual(ct.plain("Aren't you, [Morwenna](/mɔːwˈɛnə/)?"), "Aren't you, Morwenna?")
        self.assertEqual(ct.words('A long-winded title!'), ['a', 'long', 'winded', 'title'])
        self.assertEqual(ct.errors(ct.words('the toast is burning'), ct.words('the toast was burning now')), 2)

    @unittest.skipUnless(HAVE['numpy'], 'needs numpy')
    def test_best_of_n_is_fewest_errors_then_nearest_the_median_length(self):
        import numpy as np
        c = lambda n, err: {'y': np.zeros(n), 'err': err}
        self.assertEqual(len(ct.best_of([c(100, 1), c(90, 0), c(130, 0)])['y']), 90)
        self.assertEqual(len(ct.best_of([c(100, 0), c(50, 0), c(160, 0)])['y']), 100)

    @unittest.skipUnless(HAVE['numpy'] and HAVE['soundfile'], 'needs numpy and soundfile')
    def test_each_unit_is_made_n_times_and_the_best_is_kept(self):
        line = kt.read_line(LINE)
        lengths = iter([0.5, 0.6, 0.7] * 3)
        heard = iter(['Close.', 'Clothes.', 'Close.', 'The kettle is on and the toast is burning.'] * 3 + ["Aren't you Morwenna?"] * 3)
        d = tempfile.mkdtemp()
        try:
            model = type('M', (), {'generate': lambda self, text, **kw: [type('R', (), {'audio': tone(next(lengths))})()]})()
            kept, log = ct.say_units(line, model, {'ref_audio': 'ref.wav'}, lambda path: next(heard), SR, 3, work=d)
        finally:
            shutil.rmtree(d)
        self.assertEqual(len(kept), 3)
        self.assertEqual(log[0]['all_errors'], [0, 1, 0])
        self.assertEqual(log[0]['kept_errors'], 0)
        self.assertEqual(log[2]['text'], "Aren't you, Morwenna?")

    def test_refusals_come_before_any_model_loads(self):
        script = os.path.join(WORK, 'say_a_line_in_a_cloned_voice.py')
        done, last = run(sys.executable, '-I', script, LINE, 'nope', '/tmp/x.wav')
        self.assertEqual(done.returncode, 2)
        self.assertIn('nope is not an engine here', last['error'])
        done, last = run(sys.executable, '-I', script, LINE, 'qwen3', '/tmp/x.wav')
        self.assertIn('no reference is not there', last['error'])
        d = tempfile.mkdtemp()
        try:
            ref = os.path.join(d, 'ref.wav'); open(ref, 'wb').close()
            done, last = run(sys.executable, '-I', script, LINE, 'qwen3', '/tmp/x.wav', '--ref', ref)
            self.assertIn('needs the exact words of the reference', last['error'])
        finally:
            shutil.rmtree(d)


import measure_takes as mt  # noqa: E402


def take_with_pauses(d):
    """A made-up take: 0.2 s quiet, tone 0.8 s, pause 0.6 s, tone 1.0 s, pause 0.1 s, tone 0.5 s, 0.3 s quiet; and words."""
    import numpy as np, soundfile as sf
    y = np.concatenate([hush(0.2), tone(0.8), hush(0.6), tone(1.0), hush(0.1), tone(0.5), hush(0.3)])
    path = os.path.join(d, 'take.wav')
    sf.write(path, y, SR, subtype='PCM_24')
    words = [{'word': ' Close.', 'start': 0.2, 'end': 1.0}, {'word': ' The', 'start': 1.6, 'end': 1.9},
             {'word': ' kettle', 'start': 1.9, 'end': 2.6}, {'word': ' boils.', 'start': 2.7, 'end': 3.2}]
    return path, words


@unittest.skipUnless(HAVE['numpy'] and HAVE['soundfile'], 'needs numpy and soundfile')
class Measure(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_pauses_of_120_ms_or_more_with_the_words_on_each_side(self):
        import soundfile as sf
        path, words = take_with_pauses(self.dir)
        y, sr = sf.read(path)
        pauses, first, last = mt.pauses_of(y, sr, words)
        self.assertEqual(len(pauses), 1, pauses)
        self.assertEqual((pauses[0]['after'], pauses[0]['before']), ('Close.', 'The'))
        self.assertAlmostEqual(pauses[0]['s'], 0.6, delta=0.02)
        self.assertAlmostEqual(first / sr, 0.2, delta=0.01)
        longer, _, _ = mt.pauses_of(y, sr, words, least_s=0.05)
        self.assertEqual(len(longer), 2)

    def test_a_silent_take_is_refused(self):
        with self.assertRaises(kt.Refusal):
            mt.pauses_of(hush(1.0), SR, [])

    def test_the_measures_of_a_take_from_saved_word_times(self):
        path, words = take_with_pauses(self.dir)
        os.makedirs(os.path.join(self.dir, 'work'))
        write(os.path.join(self.dir, 'work', 'take.words.json'),
              {'words': [{'text': w['word'].strip(), 'start': w['start'], 'end': w['end']} for w in words]})
        line = {'script': 'Close. The kettle boils.', 'vowel_check': {'word': 'close'}}
        seen = {}
        real = mt.pitch_of
        mt.pitch_of = lambda p, a, b, cfg: seen.update(span=(a, b)) or {'f0_p5': 100, 'f0_p95': 200, 'span_st': 12.0, 'vowel_onset_f2': 1400, 'vowel_ms': 200}
        try:
            row = mt.measure(path, line, kt.settings(), words_from=os.path.join(self.dir, 'work'), voice_models=False)
        finally:
            mt.pitch_of = real
        self.assertEqual(seen['span'], (0.2, 1.0), 'the vowel is measured on the vowel_check word')
        self.assertEqual(row['heard'], 'Close. The kettle boils.')
        self.assertEqual((row['word_errors'], row['script_words']), (0, 4))
        self.assertAlmostEqual(row['speech_seconds'], 3.0, delta=0.03)
        self.assertEqual(row['words_per_s'], round(4 / row['speech_seconds'], 2))
        self.assertEqual(row['articulation_wps'], round(4 / (row['speech_seconds'] - row['pauses'][0]['s']), 2))
        self.assertEqual(row['longest_pause_s'], row['pauses'][0]['s'])
        self.assertNotIn('same_voice', row)
        self.assertEqual(row['f0_p95'], 200)

    def test_wer_is_a_word_level_levenshtein(self):
        self.assertEqual(mt.wer(mt.norm('Progress Studies'), mt.norm('Progress Study')), 1)
        self.assertEqual(mt.wer(mt.norm("Aren't you, Morwenna?"), mt.norm("Aren't you Morwenna")), 0)

    def test_refusals_say_what_to_pass(self):
        script = os.path.join(WORK, 'measure_takes.py')
        done, last = run(sys.executable, '-I', script, LINE, os.path.join(self.dir, 'absent.wav'))
        self.assertEqual(done.returncode, 2)
        self.assertIn('is not there', last['error'])
        path, _ = take_with_pauses(self.dir)
        done, last = run(sys.executable, '-I', script, LINE, path, '--no-voice-models', '--words-from', os.path.join(self.dir, 'nowhere'))
        self.assertIn('take.words.json is not there', last['error'])

    @unittest.skipIf(HAVE['parselmouth'], 'parselmouth is installed here')
    def test_without_parselmouth_the_pitch_measure_says_how_to_install(self):
        with self.assertRaises(kt.Refusal) as caught:
            mt.pitch_of(LINE, 0, 1, {**kt.settings(), 'parselmouth_python': sys.executable})
        self.assertIn('pip install praat-parselmouth', str(caught.exception))


class Render(unittest.TestCase):
    script = os.path.join(WORK, 'render_takes.sh')

    def test_refusals_say_what_to_pass(self):
        done, last = run('bash', self.script)
        self.assertEqual(done.returncode, 2)
        self.assertIn('pass <line.json> <out dir>', last['error'])
        done, last = run('bash', self.script, '/nowhere/line.json', tempfile.gettempdir())
        self.assertIn('is not there', last['error'])

    def test_the_master_program_must_be_there(self):
        d = tempfile.mkdtemp()
        try:
            env = {**os.environ, 'PATH': os.pathsep.join([os.path.dirname(sys.executable), '/usr/bin', '/bin'])}
            done, last = run('bash', self.script, LINE, d, env=env)
            self.assertEqual(done.returncode, 2)
            self.assertIn('showtime is not installed', last['error'])
        finally:
            shutil.rmtree(d)

    @unittest.skipIf(HAVE['mlx_audio'], 'mlx-audio is installed here')
    @unittest.skipUnless(NODE, 'needs node')
    def test_a_take_that_cannot_be_made_stops_the_render_and_says_why(self):
        d = tempfile.mkdtemp()
        try:
            # The made-up settings: master_command empty (no master), the takes pocket then af_heart. Read by the stand-in
            # reader in place of tools/settings, which this test cannot assume.
            env = {**os.environ, 'NODE': NODE}
            fake_root = os.path.join(d, 'root')
            shutil.copytree(os.path.join(WORK), os.path.join(fake_root, 'tools', 'compare-voice-and-music-models', 'do-work'))
            os.makedirs(os.path.join(fake_root, 'tools', 'settings', 'read-data'))
            shutil.copy(STAND_IN, os.path.join(fake_root, 'tools', 'settings', 'read-data', 'settings-record.mjs'))
            write(os.path.join(fake_root, 'capabilities.json'), '{}')
            script = os.path.join(fake_root, 'tools', 'compare-voice-and-music-models', 'do-work', 'render_takes.sh')
            ref = os.path.join(d, 'ref.wav'); open(ref, 'wb').close()
            done, last = run('bash', script, LINE, os.path.join(d, 'out'), os.path.join(FIX, 'settings-row.json'), env=env)
            self.assertEqual(done.returncode, 2, done.stderr)
            self.assertIn('take pocket was not made', last['error'])
        finally:
            shutil.rmtree(d)


if __name__ == '__main__':
    unittest.main()
