"""Runs filmcraft_insert_frame_holds.py for real on a made-up FilmCraft-shaped project.

The project is one 24 fps sequence with one 10 second clip (picture and linked sound), an adjustment layer over it
and three empty tracks of each kind. The inserted overlay and two sound files are generated with ffmpeg, so these
tests skip where ffmpeg and ffprobe are not found.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(os.path.dirname(HERE), 'do-work')
sys.path.insert(0, WORK)
import filmcraft_insert_frame_holds as fh  # noqa: E402

FFMPEG = shutil.which('ffmpeg') and shutil.which('ffprobe')
FD = fh.TPS // 24  # ticks per frame at 24 fps
PLATE = '/made-up/plate.mp4'


def clip(cid, item, start, duration, link=None, effects=None):
    return {'id': cid, 'item': item, 'name': f'clip {cid}', 'label': None, 'start': start, 'duration': duration, 'source_in': 0, 'speed': 1.0,
            'reverse': False, 'enabled': True, 'link': link, 'group': None, 'markers': [], 'gain_db': 0.0, 'frame_hold': None,
            'scale_to_frame': False, 'effects': effects if effects is not None else []}


def project():
    fx = [{'effect': 'motion', 'params': {}}, {'effect': 'opacity', 'params': {}}, {'effect': 'lumetri', 'params': {}}]
    seq = {'settings': {'frame_rate': {'num': 24, 'den': 1}},
           'video_tracks': [{'items': [clip(10, 1, 0, 240 * FD, link=7, effects=[{'effect': 'lumetri', 'params': {}}])]},
                            {'items': [clip(12, 3, 0, 240 * FD, effects=fx)]},
                            {'items': []}],
           'audio_tracks': [{'items': [clip(11, 1, 0, 240 * FD, link=7)]}, {'items': []}, {'items': []}]}
    return {'project': {'name': 'before', 'next_id': 100, 'root': {'children': []},
                        'items': {'1': {'id': 1, 'kind': {'Media': {'media': {'File': {'path': PLATE}}}}},
                                  '2': {'id': 2, 'name': 'Main', 'kind': {'Sequence': seq}},
                                  '3': {'id': 3, 'kind': {'AdjustmentLayer': {}}}}}}


def run_ffmpeg(*argv):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *argv], check=True)


@unittest.skipUnless(FFMPEG, 'needs ffmpeg and ffprobe')
class FilmcraftInsertTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.shots = os.path.join(self.tmp, 'shots')
        self.out = os.path.join(self.tmp, 'out')
        os.makedirs(self.shots)
        self.make_shot('s1', frame=48, overlay_frames=12)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def make_shot(self, sid, frame, overlay_frames, source=PLATE):
        with open(os.path.join(self.shots, sid + '.json'), 'w') as f:
            json.dump({'id': sid, 'plate': {'source': source, 'frame': frame}}, f)
        folder = os.path.join(self.out, sid)
        os.makedirs(folder)
        run_ffmpeg('-f', 'lavfi', '-i', 'color=c=black@0.0:s=64x36:r=24', '-frames:v', str(overlay_frames), '-c:v', 'prores_ks',
                   '-profile:v', '4', '-pix_fmt', 'yuva444p10le', os.path.join(folder, f'{sid}-overlay-prores4444.mov'))
        for name in ('narrator', 'sfx-music'):
            run_ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.5', '-c:a', 'pcm_s24le', os.path.join(folder, f'{sid}-{name}.wav'))

    def insert(self, d, shots=('s1',)):
        return fh.insert_frame_holds(d, list(shots), self.shots, self.out, ' + fixes')

    def test_the_hold_is_ripple_inserted_and_every_track_carries_along(self):
        d = project()
        log = self.insert(d)
        self.assertEqual(log, [{'shot': 's1', 'frames': 12, 'seconds': 0.5, 'at_seconds': 2.0, 'hold_frame': 48}])
        seq = d['project']['items']['2']['kind']['Sequence']
        v0 = seq['video_tracks'][0]['items']
        self.assertEqual([(c['start'], c['duration'], c['source_in'], c['frame_hold']) for c in v0],
                         [(0, 48 * FD, 0, None), (48 * FD, 12 * FD, 48 * FD, 48 * FD), (60 * FD, 192 * FD, 48 * FD, None)])
        self.assertEqual(v0[1]['effects'], v0[0]['effects'])  # the hold keeps the clip's own grade
        self.assertEqual(seq['video_tracks'][1]['items'][0]['duration'], 252 * FD)  # the adjustment layer grew, not razored

    def test_linked_halves_get_one_new_link(self):
        d = project()
        self.insert(d)
        seq = d['project']['items']['2']['kind']['Sequence']
        right_picture = seq['video_tracks'][0]['items'][2]
        right_sound = seq['audio_tracks'][0]['items'][1]
        self.assertEqual(seq['audio_tracks'][0]['items'][0]['link'], 7)
        self.assertEqual(right_picture['link'], right_sound['link'])
        self.assertNotEqual(right_picture['link'], 7)

    def test_overlay_and_sound_land_at_the_hold_on_their_tracks(self):
        d = project()
        self.insert(d)
        seq = d['project']['items']['2']['kind']['Sequence']
        placed = [seq['video_tracks'][2]['items'][0], seq['audio_tracks'][1]['items'][0], seq['audio_tracks'][2]['items'][0]]
        self.assertEqual([c['name'] for c in placed], ['s1-overlay-prores4444.mov', 's1-narrator.wav', 's1-sfx-music.wav'])
        self.assertEqual([c['label'] for c in placed], ['Rose', 'Caribbean', 'Mango'])
        for c in placed:
            self.assertEqual((c['start'], c['duration'], c['source_in']), (48 * FD, 12 * FD, 0))
        items = d['project']['items']
        overlay = items[str(placed[0]['item'])]['kind']['Media']['info']
        self.assertTrue(overlay['video']['has_alpha'])
        self.assertEqual(overlay['video']['codec'], 'Apple ProRes 4444')
        self.assertEqual(items[str(placed[1]['item'])]['kind']['Media']['info']['kind'], 'AudioOnly')
        self.assertEqual([c['effect'] for c in seq['audio_tracks'][1]['items'][0]['effects']], ['volume', 'channel_volume', 'panner'])
        self.assertEqual([e['effect'] for e in placed[0]['effects']], ['motion', 'opacity'])  # the adjustment layer's grade is not copied
        self.assertEqual(d['project']['root']['children'], [{'Item': placed[0]['item']}, {'Item': placed[1]['item']}, {'Item': placed[2]['item']}])

    def test_ids_stay_unique_and_the_sequence_is_renamed(self):
        d = project()
        self.insert(d)
        ids = [c['id'] for tr in d['project']['items']['2']['kind']['Sequence']['video_tracks'] + d['project']['items']['2']['kind']['Sequence']['audio_tracks'] for c in tr['items']]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertGreater(d['project']['next_id'], 100)
        self.assertEqual(d['project']['items']['2']['name'], 'Main + fixes')

    def test_two_shots_in_a_row_each_move_the_later_one(self):
        self.make_shot('s2', frame=96, overlay_frames=24)
        d = project()
        self.insert(d, ('s1', 's2'))
        v0 = d['project']['items']['2']['kind']['Sequence']['video_tracks'][0]['items']
        holds = [c for c in v0 if c['frame_hold'] is not None]
        self.assertEqual([(c['start'], c['duration']) for c in holds], [(48 * FD, 12 * FD), (108 * FD, 24 * FD)])

    def test_refusals_say_what_to_change(self):
        with self.assertRaisesRegex(fh.Refusal, 'does not exist; name a shot file'):
            self.insert(project(), ('nope',))
        self.make_shot('s3', frame=48, overlay_frames=6, source='/made-up/other.mp4')
        with self.assertRaisesRegex(fh.Refusal, 'not a media file of the project'):
            self.insert(project(), ('s3',))
        self.make_shot('s4', frame=300, overlay_frames=6)
        with self.assertRaisesRegex(fh.Refusal, 'no clip on the first video track holds source frame 300'):
            self.insert(project(), ('s4',))
        os.remove(os.path.join(self.out, 's1', 's1-narrator.wav'))
        with self.assertRaisesRegex(fh.Refusal, 'render the shot into --out first'):
            self.insert(project())

    def test_the_command_writes_a_new_project_and_prints_one_answer(self):
        src = os.path.join(self.tmp, 'in.fcproj')
        dst = os.path.join(self.tmp, 'new.fcproj')
        with open(src, 'w') as f:
            json.dump(project(), f)
        done = subprocess.run([sys.executable, '-I', os.path.join(WORK, 'filmcraft_insert_frame_holds.py'), src, dst, '--shots', self.shots,
                               '--out', self.out, 's1'], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        answer = json.loads(done.stdout.strip().splitlines()[-1])
        self.assertEqual(answer['result']['output'], dst)
        with open(dst) as f:
            written = json.load(f)
        self.assertEqual(written['project']['name'], 'new')
        self.assertEqual(written['project']['items']['2']['name'], 'Main + corrections')
        with open(src) as f:
            self.assertEqual(json.load(f)['project']['name'], 'before')  # the input is never written

    def test_the_command_refuses_to_write_over_its_input_and_says_so_in_json(self):
        src = os.path.join(self.tmp, 'in.fcproj')
        with open(src, 'w') as f:
            json.dump(project(), f)
        done = subprocess.run([sys.executable, '-I', os.path.join(WORK, 'filmcraft_insert_frame_holds.py'), src, src, '--shots', self.shots,
                               '--out', self.out, 's1'], capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)
        self.assertIn('must be a new file', json.loads(done.stdout.strip().splitlines()[-1])['error'])


if __name__ == '__main__':
    unittest.main()
