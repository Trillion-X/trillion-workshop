"""Tests for do-work/pull_window.py on a made-up camera file served by a stand-in reader."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / 'do-work' / 'pull_window.py'
FAKE = HERE / 'fake_reader.py'
sys.path.insert(0, str(SCRIPT.parent))
import pull_window as pw  # noqa: E402

HAVE_FFMPEG = shutil.which('ffmpeg') and shutil.which('ffprobe')


def make_camera_file(path):
    """5 s of picture (a key frame every second) and a tone, moov at the end like a camera file."""
    subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=5',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-shortest', str(path)], check=True)


def served(log):
    return [tuple(int(x) for x in line.split()) for line in Path(log).read_text().splitlines()]


def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)], capture_output=True, text=True)
    return float(out.stdout)


def packets(path, stream):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pos,size', '-of', 'json', str(path)],
                         capture_output=True, text=True, check=True)
    return [(int(p['pos']), int(p['size'])) for p in json.loads(out.stdout)['packets']]


@unittest.skipUnless(HAVE_FFMPEG, 'needs ffmpeg and ffprobe on PATH')
class PullWindow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='pull-window-'))
        cls.store = cls.tmp / 'stored.mp4'
        make_camera_file(cls.store)
        cls.size = cls.store.stat().st_size

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def request(self, name, **over):
        log = self.tmp / f'{name}.log'
        for stale in (log, Path(str(log) + '.calls')):
            stale.unlink(missing_ok=True)
        req = {'identity': '12:made-up', 'store': str(self.store), 'account': 'acct-made-up', 'out': str(self.tmp / f'{name}.out'),
               'reader': {'argv': [sys.executable, str(FAKE), '{store}', '{account}', 'one', '{identity}', '{out}', '{offset}', '{length}'],
                          'env': {'FAKE_READER_LOG': str(log)}, 'retry_seconds': 0}}
        req.update(over)
        return req, log

    def run_cli(self, req):
        path = self.tmp / 'request.json'
        path.write_text(json.dumps(req))
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), '--request', str(path)], capture_output=True, text=True,
                              env=dict(os.environ, FAKE_READER_LOG=req['reader']['env']['FAKE_READER_LOG']))
        return done, json.loads(done.stdout.strip().split('\n')[-1])

    def test_window_wav_starts_with_silence_up_to_from_and_is_as_long_as_to(self):
        req, log = self.request('window', **{'from': 2.0, 'to': 3.5, 'out': str(self.tmp / 'w.wav')})
        done, answer = self.run_cli(req)
        self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        self.assertAlmostEqual(duration(self.tmp / 'w.wav'), 3.5, delta=0.15)
        self.assertEqual(answer['result']['mode'], 'window')
        self.assertGreater(answer['result']['audio_packets'], 0)

    def test_only_headers_moov_and_audio_packets_are_read_when_no_gap_is_joined(self):
        req, log = self.request('strict', **{'from': 1.0, 'to': 2.0, 'gap': 0, 'out': str(self.tmp / 's.wav')})
        done, answer = self.run_cli(req)
        self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        video = packets(self.store, 'v:0')
        for offset, length in served(log):
            if length == 16:      # a box header read: 8 header bytes and, for the media box, the first 8 bytes after them
                continue
            for v_pos, v_size in video:
                self.assertFalse(offset < v_pos + v_size and v_pos < offset + length, f'range {offset}+{length} touches a video packet at {v_pos}')
        self.assertLess(answer['result']['bytes_fetched'], self.size)

    def test_default_gap_joins_near_audio_packets_into_fewer_reads(self):
        strict_req, _ = self.request('g0', **{'from': 0.5, 'to': 3.5, 'gap': 0, 'out': str(self.tmp / 'g0.wav')})
        joined_req, _ = self.request('g1', **{'from': 0.5, 'to': 3.5, 'out': str(self.tmp / 'g1.wav')})
        _, strict = self.run_cli(strict_req)
        _, joined = self.run_cli(joined_req)
        self.assertLessEqual(joined['result']['audio_reads'], strict['result']['audio_reads'])
        self.assertEqual(joined['result']['audio_packets'], strict['result']['audio_packets'])

    def test_frame_mode_reads_one_video_packet_and_writes_a_picture(self):
        req, log = self.request('frame', mode='frame', at=2.2, out=str(self.tmp / 'f.jpg'))
        done, answer = self.run_cli(req)
        self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        self.assertGreater((self.tmp / 'f.jpg').stat().st_size, 500)
        self.assertAlmostEqual(answer['result']['frame_at'], 2.0, delta=0.05)
        video = packets(self.store, 'v:0')
        touched = {(v_pos, v_size) for offset, length in served(log) if length != 16
                   for v_pos, v_size in video if offset < v_pos + v_size and v_pos < offset + length}
        self.assertEqual(len(touched), 1, 'exactly one video packet is fetched')

    def test_a_busy_reader_is_retried_and_a_dead_one_is_refused_with_what_was_asked(self):
        req, _ = self.request('retry', **{'from': 1.0, 'to': 1.5, 'out': str(self.tmp / 'r.wav')})
        req['reader']['env']['FAKE_READER_FAIL_FIRST'] = '2'
        done, answer = self.run_cli(req)
        self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        dead, _ = self.request('dead', **{'from': 1.0, 'to': 1.5, 'out': str(self.tmp / 'd.wav')})
        dead['reader']['env']['FAKE_READER_FAIL_FIRST'] = '999'
        dead['reader']['retries'] = 2
        done, answer = self.run_cli(dead)
        self.assertEqual(done.returncode, 1)
        self.assertIn('range read failed at 0+16', answer['error'])

    def test_request_refusals_say_what_to_change(self):
        base, _ = self.request('refuse', **{'from': 1.0, 'to': 2.0})
        for drop, words in (('account', 'storage account id'), ('store', 'store is required'), ('identity', 'identity is required'), ('out', 'out is required')):
            req = {k: v for k, v in base.items() if k != drop}
            done, answer = self.run_cli(req)
            self.assertEqual(done.returncode, 1)
            self.assertIn(words, answer['error'])
        done, answer = self.run_cli(dict(base, to=0.5))
        self.assertIn('with to after from', answer['error'])
        done, answer = self.run_cli(dict(base, mode='frame'))
        self.assertIn('at is required', answer['error'])
        done, answer = self.run_cli(dict(base, reader={'env': base['reader']['env']}))
        self.assertIn('reader.argv is required', answer['error'])

    def test_a_credential_the_reader_needs_must_be_set_and_its_value_is_never_printed(self):
        req, _ = self.request('cred', **{'from': 1.0, 'to': 1.5, 'out': str(self.tmp / 'c.wav'), 'credentials': ['MADE_UP_STORAGE_KEY']})
        done, answer = self.run_cli(req)
        self.assertEqual(done.returncode, 1)
        self.assertIn('MADE_UP_STORAGE_KEY', answer['error'])
        path = self.tmp / 'request.json'
        path.write_text(json.dumps(req))
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), '--request', str(path)], capture_output=True, text=True,
                              env=dict(os.environ, FAKE_READER_LOG=req['reader']['env']['FAKE_READER_LOG'], MADE_UP_STORAGE_KEY='s3cret-value'))
        self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        self.assertNotIn('s3cret-value', done.stdout + done.stderr)


class Pure(unittest.TestCase):
    def test_join_ranges_joins_only_within_the_gap(self):
        self.assertEqual(pw.join_ranges([(100, 10), (115, 10), (1000, 10)], 10), [[100, 25], [1000, 10]])
        self.assertEqual(pw.join_ranges([(100, 10), (115, 10)], 0), [[100, 10], [115, 10]])
        self.assertEqual(pw.join_ranges([], 5), [])

    def test_a_file_with_a_box_running_to_the_end_is_refused(self):
        class Fake:
            def read(self, ident, offset, length, tmp):
                return b'\x00\x00\x00\x00ftyp' + b'\x00' * 8
        pw.READER = Fake()
        with self.assertRaisesRegex(SystemExit, 'runs to the end of the file'):
            pw.walk_boxes('12:made-up', '.')


@unittest.skipUnless(HAVE_FFMPEG, 'needs ffmpeg and ffprobe on PATH')
class Settings(unittest.TestCase):
    """The person's storage (store, account, reader) as settings, the request on standard input, out in the granted folder."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='pull-window-settings-'))
        cls.store = cls.tmp / 'stored.mp4'
        make_camera_file(cls.store)
        cls.log = cls.tmp / 'served.log'
        cls.storage = {'store': str(cls.store), 'account': 'acct-made-up',
                       'reader': {'argv': [sys.executable, str(FAKE), '{store}', '{account}', 'one', '{identity}', '{out}', '{offset}', '{length}'],
                                  'env': {'FAKE_READER_LOG': str(cls.log)}, 'retry_seconds': 0}}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_stdin(self, request, *extra):
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), *extra], input=json.dumps(request), capture_output=True, text=True)
        return done, json.loads(done.stdout.strip().split('\n')[-1])

    def test_storage_from_settings_and_out_in_the_granted_folder(self):
        granted = self.tmp / 'granted'
        granted.mkdir(exist_ok=True)
        request = {'identity': '12:made-up', 'from': 1.0, 'to': 2.0, 'out': 'w.wav', 'settings': self.storage,
                   'settings_from': {'id': 'record:setting:pull-a-time-window-from-a-stored-camera-file~person~all', 'from': 'made up'}}
        done, answer = self.run_stdin(request, '--base', str(granted))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertTrue((granted / 'w.wav').is_file())
        self.assertEqual(answer['result']['out'], str(granted / 'w.wav'))
        self.assertEqual(answer['result']['settings_from']['from'], 'made up')

    def test_a_key_at_the_top_of_the_request_wins_over_the_setting(self):
        request = {'identity': '12:made-up', 'from': 1.0, 'to': 2.0, 'out': str(self.tmp / 'x.wav'), 'settings': self.storage,
                   'store': str(self.tmp / 'absent.mp4')}
        done, answer = self.run_stdin(request)
        self.assertEqual(done.returncode, 1)
        self.assertIn('error', answer)

    def test_the_old_command_line_reads_its_storage_from_the_settings_file(self):
        record = {'id': 'record:setting:pull-a-time-window-from-a-stored-camera-file~person~all', 'type': 'record:setting',
                  'value': {'name': 'made up', 'tool': 'tool:pull-a-time-window-from-a-stored-camera-file', 'scope_kind': 'person', 'scope_id': 'all',
                            'settings': json.dumps(self.storage), 'from': 'made up', 'status': 'active'}}
        path = self.tmp / 'storage.json'
        path.write_text(json.dumps(record))
        env = dict(os.environ, PULL_WINDOW_SETTINGS=str(path))
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), '12:made-up', '1', '2', str(self.tmp / 'old.wav')], capture_output=True, text=True, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(done.stdout.startswith('12:made-up 1.0-2.0: '), done.stdout)
        self.assertTrue((self.tmp / 'old.wav').is_file())
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), 'frame', '12:made-up', '2.0', str(self.tmp / 'old.jpg')], capture_output=True, text=True, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('frame at', done.stdout)

    def test_no_store_anywhere_is_refused_with_what_to_give(self):
        done, answer = self.run_stdin({'identity': '12:made-up', 'from': 1.0, 'to': 2.0, 'out': 'x.wav',
                                       'settings': {'reader': self.storage['reader'], 'account': 'acct'}})
        self.assertEqual(done.returncode, 1)
        self.assertIn('store is required', answer['error'])

    def test_configured_lays_defaults_settings_and_the_request_in_that_order(self):
        cfg = pw.configured({'settings': {'gap': 5, 'store': 's'}, 'store': 't'})
        self.assertEqual((cfg['gap'], cfg['store'], cfg['account'], cfg['credentials']), (5, 't', None, []))
        self.assertEqual(pw.configured({})['gap'], pw.DEFAULT_GAP)


def record(folder, settings, status='active'):
    """A row as run-with-settings.mjs hands it in: {id, type, value}, settings as the compact JSON text make_record writes."""
    return {'id': f'record:setting:{folder}~film~sample-film', 'type': 'record:setting',
            'value': {'name': 'made up', 'tool': f'tool:{folder}', 'scope_kind': 'film', 'scope_id': 'sample-film',
                      'settings': json.dumps(settings, sort_keys=True, separators=(',', ':')), 'from': 'made up', 'status': status}}


class SettingsRecord(unittest.TestCase):
    def test_storage_is_read_from_the_record_and_a_retired_record_is_refused(self):
        cfg = pw.configured({'settings_record': record('pull-a-time-window-from-a-stored-camera-file', {'store': 's', 'account': 'a', 'gap': 9})})
        self.assertEqual((cfg['store'], cfg['account'], cfg['gap']), ('s', 'a', 9))
        cfg = pw.configured({'settings_record': record('pull-a-time-window-from-a-stored-camera-file', {'store': 's'}), 'settings': {'store': 't'}})
        self.assertEqual(cfg['store'], 't')
        with self.assertRaisesRegex(ValueError, 'retired'):
            pw.configured({'settings_record': record('pull-a-time-window-from-a-stored-camera-file', {'store': 's'}, 'retired')})

if __name__ == '__main__':
    unittest.main()
