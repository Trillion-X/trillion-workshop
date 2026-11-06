#!/usr/bin/env python3
"""tools/render-a-motion-graphics-overlay do-work/render_an_overlay_insert.py on made-up shots, the made-up example look
and made-up media made here with ffmpeg (a camera clip, a graded export with sound, a voice).

Run: python3 test/test_render_an_overlay_insert.py   (needs Pillow, numpy, OpenCV and ffmpeg with prores_ks and libx264)
The claim check is the real tool:check-every-claim-against-its-facts-and-sources on its own made-up world
(tools/check-every-claim-against-its-facts-and-sources/test/fixture_world.py)."""
import glob
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.dirname(HERE)
PROGRAM = os.path.join(TOOL, 'do-work', 'render_an_overlay_insert.py')
EXAMPLE = os.path.join(TOOL, 'read-data', 'example-look')
LOOK = json.load(open(os.path.join(EXAMPLE, 'look.json')))
# the example look's music bed is its one short click: the bed starts at its start (ffmpeg 6.1 can wait for ever on a
# wav bed seeked past its end)
LOOK['recipe']['sound']['music'] = dict(LOOK['recipe']['sound']['music'], start_s=0.0)
CLAIMS_TEST = os.path.join(os.path.dirname(TOOL), 'check-every-claim-against-its-facts-and-sources', 'test')
sys.path.insert(0, CLAIMS_TEST)
import fixture_world  # noqa: E402  (the claim check's made-up world)

FPS = 24000 / 1001
SKIP = {'skip': 'a made-up shot that makes no claim'}


def ff(*args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *args], check=True)


def probe(path, entries='stream=codec_name,pix_fmt,width,height,nb_read_frames', stream='v:0', count=False):
    cmd = ['ffprobe', '-v', 'error', '-select_streams', stream, '-show_entries', entries, '-of', 'json'] + (['-count_frames'] if count else []) + [path]
    return json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout)['streams'][0]


def duration(path):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                                capture_output=True, text=True, check=True).stdout)


def audio_seconds(path):
    """The preview's sound stream length. (Its picture stream is the same length on the ffmpeg the film used; ffmpeg 6.1
    repeats the frozen frame past the end of the insert with this filter graph, in the old code as in this port.)"""
    return float(probe(path, 'stream=duration', 'a:0')['duration'])


def run(request):
    p = subprocess.run([sys.executable, PROGRAM], input=json.dumps(request), capture_output=True, text=True, timeout=900)
    last = p.stdout.strip().split('\n')[-1] if p.stdout.strip() else ''
    return p.returncode, (json.loads(last) if last.startswith('{') else None), p


class Insert(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.media = os.path.join(cls.tmp.name, 'media')
        os.makedirs(cls.media)
        m = cls.media
        ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24000/1001', '-t', '6', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', f'{m}/camera.mp4')
        ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24000/1001', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
           '-t', '20', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', f'{m}/graded.mp4')
        ff('-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '1.2', f'{m}/voice.wav')
        with open(f'{m}/voice.words.json', 'w') as f:
            json.dump({'words': [{'text': 'made-up', 'start': 0.1, 'end': 0.5}, {'text': 'words.', 'start': 0.6, 'end': 1.1}]}, f)
        Image.new('RGB', (640, 360), (90, 110, 130)).save(f'{m}/cutout.png')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def shot(self, sid='made-up-shot', **extra):
        return {'id': sid, 'canvas': [640, 360], 'voice': {'wav': 'voice.wav', 'words': 'voice.words.json', 'start_s': 0.25},
                'plate': {'source': 'camera.mp4', 'frame': 40}, 'graded_frame': {'export': 'graded.mp4', 'cut_frame': 200},
                'cut_insert_s': 8.0, 'preview_after_start_s': 8.0, 'cutout': {'image': 'cutout.png'},
                'events': [{'type': 'pause', 'at': 0.0}, {'type': 'exit', 'at': ['words.', 0.0]}], **extra}

    def request(self, out, spec=None, **extra):
        return {'settings': LOOK, 'assets': EXAMPLE, 'root': self.media, 'out': out, 'spec': spec or self.shot(),
                'preview_encoder': 'libx264', 'claim_check': SKIP, **extra}

    def test_a_full_insert_writes_every_file_aligned_to_the_overlays_first_frame(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, p = run(self.request(out))
            self.assertEqual(code, 0, p.stderr[-1500:])
            got = answer['result']['inserts'][0]
            # a shot without duration_s lasts until its exit's light leak and its last word are done
            exit_s = 0.25 + 0.6
            dur = max(exit_s + LOOK['recipe']['exit']['leak_s'], 0.25 + 1.1) + 0.05
            frames = math.ceil(dur * FPS)
            self.assertEqual((got['id'], got['frames']), ('made-up-shot', frames))
            folder = os.path.join(out, 'made-up-shot')
            self.assertEqual(sorted(os.listdir(folder)), sorted(f'made-up-shot-{n}' for n in (
                'overlay-prores4444.mov', 'narrator.wav', 'sfx-music.wav', 'plate-slog3-prores422hq.mov', 'plate-graded-prores422hq.mov',
                'preview.mp4', 'timeline.json')), 'every file, and no scratch plate frame left behind')
            ov = probe(got['overlay'], count=True)
            self.assertEqual((ov['codec_name'], ov['pix_fmt'][:4], ov['width'], ov['height'], int(ov['nb_read_frames'])), ('prores', 'yuva', 640, 360, frames))
            plate = probe(got['plate'], count=True)
            self.assertEqual((plate['codec_name'], plate['width'], int(plate['nb_read_frames'])), ('prores', 320, frames), 'the camera frame, as shot')
            graded = probe(got['plate_graded'], count=True)
            self.assertEqual((graded['width'], graded['height'], int(graded['nb_read_frames'])), (1920, 1080, frames))
            for wav in (got['narrator'], got['sfx_music']):
                self.assertAlmostEqual(duration(wav), frames / FPS, delta=0.01)
            self.assertAlmostEqual(audio_seconds(got['preview']), 3 + frames / FPS + 3, delta=0.15)
            self.assertEqual(probe(got['preview'])['width'], 1920)
            tl = json.load(open(got['timeline']))
            self.assertEqual((tl['frames'], tl['exit_s'], tl['voice_start_s']), (frames, round(exit_s, 3), 0.25))
            self.assertEqual([s['kind'] for s in tl['sounds']], ['pause', 'whoosh', 'rip'])
            self.assertEqual(got['claim_check'], ['made-up-shot: claim check skipped: a made-up shot that makes no claim'])

    def test_with_nothing_after_the_insert_the_preview_ends_with_it(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, p = run(self.request(out, self.shot(preview_after_start_s=None, duration_s=1.0), mode='quick'))
            self.assertEqual(code, 0, p.stderr[-1500:])
            got = answer['result']['inserts'][0]
            self.assertEqual(got['frames'], math.ceil(1.0 * FPS), 'a shot that gives duration_s keeps it')
            self.assertAlmostEqual(audio_seconds(got['preview']), 3 + got['frames'] / FPS, delta=0.15)

    def test_quick_pipes_the_overlay_into_a_540p_preview_and_copies_it_to_the_picker(self):
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as picker:
            code, answer, p = run(self.request(out, mode='quick', copy_previews_to={'folder': picker, 'names': {'made-up-shot': 'slot-A-recommended'}}))
            self.assertEqual(code, 0, p.stderr[-1500:])
            got = answer['result']['inserts'][0]
            self.assertEqual(glob.glob(os.path.join(out, '*', '*.mov')), [], 'no ProRes file in a quick render')
            self.assertEqual((probe(got['preview'])['width'], probe(got['preview'])['height']), (960, 540))
            self.assertEqual(got['copied_to'], os.path.join(picker, 'slot-A-recommended.mp4'))
            self.assertEqual(open(got['copied_to'], 'rb').read(), open(got['preview'], 'rb').read())

    def test_audio_only_renders_the_sound_and_preview_against_the_full_renders_overlay(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, _ = run(self.request(out, mode='audio_only'))
            self.assertEqual(code, 1)
            self.assertIn('audio_only needs the overlay a full render wrote', answer['error'])
            self.assertEqual(run(self.request(out))[0], 0)
            overlay = os.path.join(out, 'made-up-shot', 'made-up-shot-overlay-prores4444.mov')
            before = os.path.getmtime(overlay)
            code, answer, p = run(self.request(out, mode='audio_only'))
            self.assertEqual(code, 0, p.stderr[-1500:])
            got = answer['result']['inserts'][0]
            self.assertEqual(os.path.getmtime(overlay), before, 'the overlay is not drawn again')
            self.assertNotIn('plate', got)
            self.assertTrue(os.path.isfile(got['preview']))

    def test_stills_draw_frames_over_the_shots_cut_out_picture(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, p = run(self.request(out, stills=[0.1, 0.5]))
            self.assertEqual(code, 0, p.stderr[-1500:])
            stills = answer['result']['inserts'][0]['stills']
            self.assertEqual([os.path.basename(s) for s in stills], ['still-00.10.jpg', 'still-00.50.jpg'])
            self.assertEqual(Image.open(stills[0]).size, (1920, 1080))

    def test_a_batch_renders_each_shot_into_its_own_folder_under_the_lock(self):
        with tempfile.TemporaryDirectory() as out:
            lock = os.path.join(out, 'render.lock')
            req = {k: v for k, v in self.request(out, stills=[0.1], lock={'file': lock}).items() if k != 'spec'}
            code, answer, p = run(dict(req, specs=[self.shot('shot-a'), self.shot('shot-b')]))
            self.assertEqual(code, 0, p.stderr[-1500:])
            self.assertEqual([a['id'] for a in answer['result']['inserts']], ['shot-a', 'shot-b'])
            self.assertTrue(os.path.isfile(os.path.join(out, 'shot-b', 'still-00.10.jpg')))
            self.assertTrue(os.path.isfile(lock))
            req = {k: v for k, v in self.request(out).items() if k != 'spec'}
            code, answer, _ = run(dict(req, specs=[self.shot('twice'), self.shot('twice')]))
            self.assertEqual(code, 1)
            self.assertIn('names a shot twice', answer['error'])

    def test_a_shot_whose_claims_fail_is_refused_before_anything_is_rendered(self):
        with tempfile.TemporaryDirectory() as world, tempfile.TemporaryDirectory() as out:
            claim_check = {k: v for k, v in fixture_world.build(world).items() if k != 'shots'}
            code, answer, p = run(self.request(out, self.shot('unsupported'), claim_check=claim_check))
            self.assertEqual(code, 1, p.stderr[-800:])
            self.assertIn('unsupported: refused, the claim check fails', answer['error'])
            self.assertIn('fact gate unsupported:', p.stdout, 'the check\'s report is printed, as the old gate\'s was')
            self.assertFalse(os.path.exists(os.path.join(out, 'unsupported')), 'nothing is rendered')
            code, answer, p = run(self.request(out, self.shot('own-claim-plain'), claim_check=claim_check, stills=[0.1]))
            self.assertEqual(code, 0, p.stderr[-800:])
            self.assertIn('fact gate own-claim-plain: PASS', answer['result']['inserts'][0]['claim_check'])

    def test_a_claim_check_that_cannot_run_or_none_at_all_is_refused(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, _ = run(self.request(out, claim_check={'lane_dir': os.path.join(out, 'absent')}))
            self.assertEqual(code, 1)
            self.assertIn('the claim check refused its request', answer['error'])
            req = self.request(out)
            del req['claim_check']
            code, answer, _ = run(req)
            self.assertEqual(code, 1)
            self.assertIn('give claim_check', answer['error'])

    def test_the_looks_insert_section_gives_the_defaults(self):
        with tempfile.TemporaryDirectory() as out:
            req = self.request(out, stills=[0.1], settings=dict(LOOK, insert={'claim_check': {'skip': 'from the look'}, 'preview_encoder': 'libx264'}))
            del req['claim_check'], req['preview_encoder']
            code, answer, p = run(req)
            self.assertEqual(code, 0, p.stderr[-800:])
            self.assertEqual(answer['result']['inserts'][0]['claim_check'], ['made-up-shot: claim check skipped: from the look'])

    def test_the_looks_picker_names_and_lock_are_used_when_the_request_gives_none(self):
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as picker:
            lock = os.path.join(out, 'look.lock')
            look = dict(LOOK, insert={'picker_names': {'made-up-shot': 'slot-B'}, 'lock': {'file': lock}})
            code, answer, p = run(self.request(out, settings=look, mode='quick', copy_previews_to={'folder': picker}))
            self.assertEqual(code, 0, p.stderr[-800:])
            self.assertEqual(answer['result']['inserts'][0]['copied_to'], os.path.join(picker, 'slot-B.mp4'))
            self.assertTrue(os.path.isfile(lock), 'the look\'s lock file was taken')

    def test_a_shot_without_an_exit_or_with_a_wrong_mode_is_refused(self):
        with tempfile.TemporaryDirectory() as out:
            code, answer, _ = run(self.request(out, self.shot(events=[{'type': 'pause', 'at': 0.0}])))
            self.assertEqual((code, answer['error']), (1, 'made-up-shot: shot has no exit event'))
            code, answer, _ = run(self.request(out, mode='slow'))
            self.assertEqual(code, 1)
            self.assertIn('mode must be one of', answer['error'])


if __name__ == '__main__':
    unittest.main()
