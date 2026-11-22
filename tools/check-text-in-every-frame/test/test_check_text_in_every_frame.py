"""Makes a 6 s clip of a made-up card with two names on every frame, and checks the pass and the missing-phrase cases."""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, '..', 'do-work', 'check_text_in_every_frame.py')


def run(*args):
    p = subprocess.run([sys.executable, '-I', TOOL, *args], capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout.strip().splitlines()[-1])


class TextInEveryFrame(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.clip = os.path.join(self.dir, 'card.mp4')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=white:size=800x400:duration=6:rate=10',
                        '-vf', "drawtext=text='Name One  Name Two':fontcolor=black:fontsize=44:x=20:y=170",
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', self.clip], check=True)

    def test_phrases_on_every_frame_pass(self):
        code, out = run(self.clip, '--phrases', json.dumps(['Name One', 'Name Two']))
        self.assertEqual(code, 0)
        self.assertTrue(out['result']['pass'])
        self.assertEqual(out['result']['frames'], 3)

    def test_absent_phrase_fails_with_frames(self):
        code, out = run(self.clip, '--phrases', json.dumps(['Name Two 2019']))
        self.assertEqual(code, 0)
        self.assertFalse(out['result']['pass'])
        self.assertEqual(len(out['result']['missing']), 3)

    def test_bad_phrases_refuse(self):
        code, out = run(self.clip, '--phrases', '"not a list"')
        self.assertEqual(code, 2)

    def test_missing_clip_refuses(self):
        code, out = run(os.path.join(self.dir, 'nope.mp4'), '--phrases', '["a"]')
        self.assertEqual(code, 2)
        self.assertIn('not there', out['error'])


if __name__ == '__main__':
    unittest.main()
