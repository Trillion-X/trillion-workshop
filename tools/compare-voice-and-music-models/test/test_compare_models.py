"""Tests of the three scripts with made-up inputs written here. render_note_events.py runs for real (numpy and
soundfile); say_lines.py and speaker_similarity.py need a voice model and a speaker model, so their argument checks,
pure parts and refusals are tested, and the model runs are not."""
import importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, '..', 'do-work')
sys.path.insert(0, WORK)
import say_lines, speaker_similarity  # noqa: E402

HAVE = {name: importlib.util.find_spec(name) is not None for name in ('numpy', 'soundfile', 'torch', 'pyannote', 'mlx_audio')}


def run(script, *args):
    done = subprocess.run([sys.executable, '-I', os.path.join(WORK, script), *args], capture_output=True, text=True)
    return done, json.loads(done.stdout.strip().splitlines()[-1])


class SayLines(unittest.TestCase):
    def test_lines_are_id_equals_text(self):
        self.assertEqual(say_lines.parse_lines(['l01=Hello there', 'b_2=a=b']), [('l01', 'Hello there'), ('b_2', 'a=b')])

    def test_bad_lines_are_refused(self):
        for arg, message in [('no-equals', 'is not <line id>=<text>'), ('=text', 'is not <line id>=<text>'),
                             ('l01=  ', 'is not <line id>=<text>'), ('../x=hi', 'names a file')]:
            with self.assertRaises(say_lines.Refusal) as caught:
                say_lines.parse_lines([arg])
            self.assertIn(message, str(caught.exception))

    def test_refusals_come_before_any_model_loads(self):
        d = tempfile.mkdtemp()
        try:
            done, last = run('say_lines.py', 'some/model', d)
            self.assertEqual(done.returncode, 2)
            self.assertIn('at least one <line id>=<text>', last['error'])
            done, last = run('say_lines.py', 'some/model', d, os.path.join(d, 'absent.wav'), 'ref words', 'l01=hi')
            self.assertIn('is not there', last['error'])
        finally:
            shutil.rmtree(d)

    @unittest.skipIf(HAVE['mlx_audio'], 'mlx-audio is installed here')
    def test_without_mlx_audio_it_says_how_to_install(self):
        d = tempfile.mkdtemp()
        try:
            ref = os.path.join(d, 'ref.wav'); open(ref, 'wb').close()
            done, last = run('say_lines.py', 'some/model', d, ref, 'ref words', 'l01=hi')
            self.assertEqual(done.returncode, 2)
            self.assertIn('pip install -U mlx-audio', last['error'])
        finally:
            shutil.rmtree(d)


class SpeakerSimilarity(unittest.TestCase):
    @unittest.skipUnless(HAVE['numpy'], 'needs numpy')
    def test_score_is_the_cosine_to_the_reference_and_its_mean(self):
        import numpy as np
        ref = np.array([1.0, 0.0, 0.0])
        sims, mean = speaker_similarity.score(ref, {'a.wav': np.array([1.0, 0.0, 0.0]), 'b.wav': np.array([0.6, 0.8, 0.0])})
        self.assertEqual(sims, {'a.wav': 1.0, 'b.wav': 0.6})
        self.assertAlmostEqual(mean, 0.8)
        self.assertEqual(speaker_similarity.score(ref, {}), ({}, None))

    def test_files_match_the_pattern_in_order(self):
        d = tempfile.mkdtemp()
        try:
            for name in ('l02.wav', 'l01.wav', 'take.wav', 'notes.txt'):
                open(os.path.join(d, name), 'w').close()
            names = lambda p: [os.path.basename(f) for f in speaker_similarity.wav_files(d, p)]
            self.assertEqual(names('*.wav'), ['l01.wav', 'l02.wav', 'take.wav'])
            self.assertEqual(names('l0*.wav'), ['l01.wav', 'l02.wav'])
        finally:
            shutil.rmtree(d)

    def test_refusals_say_what_to_pass(self):
        d = tempfile.mkdtemp()
        try:
            ref = os.path.join(d, 'ref.wav'); open(ref, 'wb').close()
            done, last = run('speaker_similarity.py', os.path.join(d, 'absent.wav'), d)
            self.assertEqual(done.returncode, 2)
            self.assertIn('is not there', last['error'])
            done, last = run('speaker_similarity.py', ref, os.path.join(d, 'nowhere'))
            self.assertIn('is not a folder', last['error'])
            if not (HAVE['torch'] and HAVE['pyannote']):
                done, last = run('speaker_similarity.py', ref, d)
                self.assertIn('pip install -U torch pyannote.audio', last['error'])
        finally:
            shutil.rmtree(d)


@unittest.skipUnless(HAVE['numpy'] and HAVE['soundfile'], 'needs numpy and soundfile')
class RenderNoteEvents(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def render(self, events):
        src, out = os.path.join(self.dir, 'events.json'), os.path.join(self.dir, 'out.wav')
        with open(src, 'w') as f:
            json.dump(events, f)
        done, last = run('render_note_events.py', src, out)
        return done, last, out

    def test_a_note_and_a_drum_become_a_stereo_wav_one_second_past_the_last_note(self):
        import numpy as np, soundfile as sf
        events = [
            {'type': 'start', 'pitch': 69, 'start_time': 0.0, 'index': 0},
            {'type': 'drum', 'start_time': 1.0},
            {'type': 'end', 'start_event_index': 0, 'end_time': 0.5},
            {'type': 'start', 'pitch': 81, 'start_time': 2.0},
        ]
        done, last, out = self.render(events)
        self.assertEqual(done.returncode, 0, done.stderr)
        # The second start has no end: it lasts 0.3 s, but the length rule counts start + 0.2 s, so 2.2 + 1.0.
        self.assertEqual(last['result'], {'wav': out, 'seconds': 3.2, 'events': 3, 'sample_rate': 48000})
        audio, rate = sf.read(out)
        info = sf.info(out)
        self.assertEqual((rate, info.channels, info.subtype), (48000, 2, 'PCM_24'))
        self.assertEqual(len(audio), int(3.2 * 48000))
        self.assertTrue(np.array_equal(audio[:, 0], audio[:, 1]))
        self.assertAlmostEqual(float(np.abs(audio).max()), 0.5, places=3)
        # The A440 note is in the first half second: its strongest frequency is 440 Hz.
        note = audio[2400:21600, 0]
        peak = np.argmax(np.abs(np.fft.rfft(note))) * 48000 / len(note)
        self.assertAlmostEqual(peak, 440, delta=5)
        self.assertLess(float(np.abs(audio[int(0.7 * 48000):int(0.95 * 48000), 0]).max()), 1e-6, 'silence between the note and the drum')
        self.assertGreater(float(np.abs(audio[48000:48000 + 2400, 0]).max()), 0.01, 'the drum sounds at 1 s')

    def test_the_same_events_give_the_same_file(self):
        events = [{'type': 'drum', 'start_time': 0.1}, {'type': 'start', 'pitch': 60, 'start_time': 0.2, 'instrument': 'drums'}]
        _, _, out = self.render(events)
        first = pathlib.Path(out).read_bytes()
        _, _, out = self.render(events)
        self.assertEqual(pathlib.Path(out).read_bytes(), first)

    def test_refusals_say_what_to_pass(self):
        done, last = run('render_note_events.py', 'only-one')
        self.assertEqual(done.returncode, 2)
        self.assertIn('pass <events.json> <out.wav>', last['error'])
        done, last = run('render_note_events.py', os.path.join(self.dir, 'absent.json'), os.path.join(self.dir, 'o.wav'))
        self.assertIn('is not there', last['error'])
        done, last, _ = self.render([{'type': 'start', 'start_time': 0}])
        self.assertIn('is not a list of note events', last['error'])


if __name__ == '__main__':
    unittest.main()
