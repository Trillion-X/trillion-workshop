"""Runs measure_speech_free.py on made-up audio and transcripts: energy silence the transcript runs across, a music-only tail
the transcript leaves empty, and the refusals."""
import json, math, os, struct, subprocess, sys, tempfile, unittest, wave

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, '..', 'do-work', 'measure_speech_free.py')
SR = 16000


def write_wav(path, parts):
    frames = b''
    for seconds, amp in parts:
        for i in range(int(seconds * SR)):
            frames += struct.pack('<h', int(amp * 32767 * math.sin(2 * math.pi * 200 * i / SR)))
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(frames)


def run(*args):
    p = subprocess.run([sys.executable, '-I', TOOL, *args], capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout.strip().splitlines()[-1])


class DeadAir(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def files(self, parts, duration, segments):
        clip = os.path.join(self.dir, 'clip.wav')
        write_wav(clip, parts)
        t = os.path.join(self.dir, 't.json')
        with open(t, 'w') as f:
            json.dump({'duration': duration, 'segments': [{'start': a, 'end': b, 'text': x} for a, b, x in segments]}, f)
        return t, clip

    def test_energy_silence_the_transcript_runs_across_is_dead_air(self):
        t, clip = self.files([(1.0, 0.5), (3.0, 0.0), (1.0, 0.5)], 5.0, [(0.0, 5.0, 'words run across the silence')])
        code, out = run(t, clip)
        self.assertEqual(code, 0)
        self.assertAlmostEqual(out['result']['longest_dead_air_s'], 3.0, delta=0.1)
        self.assertEqual(out['result']['stretches'][0]['flagged_by'], ['energy'])

    def test_music_only_tail_is_dead_air_by_transcript(self):
        t, clip = self.files([(1.0, 0.5), (8.0, 0.5)], 9.0, [(0.0, 1.0, 'spoken')])
        code, out = run(t, clip)
        self.assertEqual(code, 0)
        self.assertAlmostEqual(out['result']['longest_dead_air_s'], 8.0, delta=0.1)
        self.assertEqual(out['result']['stretches_over_threshold'], 1)
        self.assertEqual(out['result']['stretches'][-1]['flagged_by'], ['transcript'])

    def test_clean_speech_has_no_dead_air(self):
        t, clip = self.files([(3.0, 0.5)], 3.0, [(0.0, 3.0, 'all speech')])
        code, out = run(t, clip)
        self.assertEqual(code, 0)
        self.assertEqual(out['result']['longest_dead_air_s'], 0.0)

    def test_no_speech_refuses(self):
        t, clip = self.files([(1.0, 0.5)], 1.0, [])
        code, out = run(t, clip)
        self.assertEqual(code, 2)
        self.assertIn('no spoken segment', out['error'])

    def test_missing_transcript_refuses(self):
        code, out = run(os.path.join(self.dir, 'nope.json'), os.path.join(self.dir, 'nope.wav'))
        self.assertEqual(code, 2)


if __name__ == '__main__':
    unittest.main()
