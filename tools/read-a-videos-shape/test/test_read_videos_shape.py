"""Runs read_videos_shape.py on a made-up 1080x1920, 30 fps, 2 s clip, and checks the refusals."""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, '..', 'do-work', 'read_videos_shape.py')


def run(*args):
    p = subprocess.run([sys.executable, '-I', TOOL, *args], capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout.strip().splitlines()[-1])


class ReadVideosShape(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.clip = os.path.join(self.dir, 'made.mp4')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30:duration=2',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', self.clip], check=True)

    def test_reads_shape(self):
        code, out = run(self.clip)
        self.assertEqual(code, 0)
        self.assertEqual((out['result']['width'], out['result']['height']), (1080, 1920))
        self.assertEqual(out['result']['fps'], 30.0)
        self.assertAlmostEqual(out['result']['duration_s'], 2.0, delta=0.05)

    def test_missing_file_refuses(self):
        code, out = run(os.path.join(self.dir, 'nope.mp4'))
        self.assertEqual(code, 2)
        self.assertIn('not there', out['error'])

    def test_no_argument_refuses(self):
        code, out = run()
        self.assertEqual(code, 2)
        self.assertIn('usage', out['error'])


if __name__ == '__main__':
    unittest.main()
