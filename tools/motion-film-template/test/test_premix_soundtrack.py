"""Tests for do-work/premix_soundtrack.py on a made-up film: two voice lines, three effects, a made-up music bed.
The run tests make their own tones with ffmpeg and are skipped where ffmpeg is missing."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / 'do-work' / 'premix_soundtrack.py'
sys.path.insert(0, str(HERE.parent / 'do-work'))
import premix_soundtrack as P  # noqa: E402

SHEET = {'DUR': 6.0, 'VO': [0.5, -0.2], 'voiced': [[0.6, 1.8], [2.4, 3.5]],
         'cues': [[0.0, 'whoosh', -12], [1.25, 'tick', -18], [4.0, 'chime', -9]]}
MUSIC = {'file': '{sound}/music/bed.wav', 'start': 2.0, 'fade_out': 1.5,
         'chain': "aresample=48000,aformat=channel_layouts=stereo,atrim={start:.3f}:{end:.3f},asetpts=PTS-STARTPTS,"
                  "volume='{gain_expr}':eval=frame,afade=t=out:st={fade_out_at:.3f}:d={fade_out}"}


def ask(request):
    r = subprocess.run([sys.executable, '-I', str(SCRIPT)], input=json.dumps(request), capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout.strip().splitlines()[-1])


class GainTest(unittest.TestCase):
    gain = {'base': -6.0, 'duck': -8.0, 'duck_pad': [0.12, 0.22], 'steps_per_second': 20, 'time_format': '.2f', 'windows': [
        {'from': 4.0, 'to': 4.5, 'to_inclusive': True, 'set': -30.0},
        {'from': 5.0, 'to': None, 'add': 3.0},
        {'from': 3.8, 'to': 4.0, 'ramp': [-6.0, -30.0]}]}

    def test_the_bed_ducks_under_a_voice_line_with_its_pads(self):
        voiced = [[1.0, 2.0]]
        self.assertEqual(P.gain_at(0.5, self.gain, voiced), -6.0)
        self.assertEqual(P.gain_at(0.88, self.gain, voiced), -14.0)      # 0.12 s before the line
        self.assertEqual(P.gain_at(2.22, self.gain, voiced), -14.0)      # 0.22 s after it
        self.assertEqual(P.gain_at(2.3, self.gain, voiced), -6.0)

    def test_a_set_window_wins_inclusive_ends_hold_and_an_add_window_adds(self):
        self.assertEqual(P.gain_at(4.0, self.gain, []), -30.0)
        self.assertEqual(P.gain_at(4.5, self.gain, []), -30.0)
        self.assertEqual(P.gain_at(5.5, self.gain, []), -3.0)

    def test_a_ramp_moves_linearly_across_its_window_and_an_open_end_is_exclusive(self):
        self.assertAlmostEqual(P.gain_at(3.9, self.gain, []), -18.0)
        g = {**self.gain, 'windows': [{'from': None, 'to': 1.0, 'set': -9}]}
        self.assertEqual(P.gain_at(0.0, g, []), -9)
        self.assertEqual(P.gain_at(1.0, g, []), -6.0)

    def test_the_expression_is_piecewise_with_the_time_format_asked(self):
        g = {**self.gain, 'windows': []}
        expr, segs = P.gain_expression(3.0, g, [[1.0, 2.0]])
        self.assertEqual([s[0] for s in segs], [0.0, 0.9, 2.25])
        self.assertTrue(expr.startswith('if(lt(t,0.90),0.50119,if(lt(t,2.25),0.19953,0.50119'))
        raw, _ = P.gain_expression(3.0, {**g, 'time_format': ''}, [[1.0, 2.0]])
        self.assertIn('lt(t,0.9),', raw)


class PlanTest(unittest.TestCase):
    def test_plan_lays_music_voices_and_effects_in_one_graph_and_writes_nothing(self):
        code, out = ask({'cue_sheet': SHEET, 'film_folder': '/films/sample', 'sound_folder': '/sound',
                         'settings': {'music': MUSIC, 'gain': {'base': -6, 'duck': -8}, 'after_mix': 'loudnorm=I=-14:TP=-1.5:LRA=11',
                                      'loudness': {'method': 'none'}}})
        self.assertEqual(code, 0, out)
        r = out['result']
        argv = r['premix']
        self.assertEqual(argv.count('-i'), 6)
        self.assertIn('/sound/music/bed.wav', argv)
        self.assertIn('/films/sample/assets/vo/l02.wav', argv)
        self.assertIn('/sound/palette/chime.wav', argv)
        graph = argv[argv.index('-filter_complex') + 1]
        self.assertIn('atrim=2.000:8.000', graph)
        self.assertIn('afade=t=out:st=4.500:d=1.5', graph)
        self.assertIn('[2:a]aresample=48000,aformat=channel_layouts=stereo,adelay=0|0[v1]', graph)   # a negative offset starts at 0
        self.assertIn('[4:a]aresample=48000,aformat=channel_layouts=stereo,volume=-18dB,adelay=1250|1250[s1]', graph)
        self.assertTrue(graph.endswith('[m][v0][v1][s0][s1][s2]amix=inputs=6:normalize=0:dropout_transition=0,atrim=0:6.0[mixed];[mixed]loudnorm=I=-14:TP=-1.5:LRA=11[pre]'))
        self.assertEqual(argv[-1], '/films/sample/assets/soundtrack.wav')
        self.assertEqual(r['counts'], {'voice_lines': 2, 'effects': 3, 'recordings': 3, 'inputs': 6})
        self.assertIsNone(r['measure'])

    def test_a_list_of_cues_with_a_duration_setting_and_a_two_pass_method(self):
        cues = [{'t': 0.1, 'sound': 'tick', 'gain_db': -10}, {'t': 1.0, 'sound': 'hit', 'gain_db': -6}]
        code, out = ask({'cue_sheet': cues, 'film_folder': 'f', 'sound_folder': 's',
                         'settings': {'duration': 3, 'loudness': {'method': 'gain-then-limit', 'measure': 'loudnorm=I=-15:print_format=json',
                                                                   'target_i': -15.0, 'limiter': 'alimiter=limit=0.7'}, 'work': '{film}/audio/premix.wav'}})
        self.assertEqual(code, 0, out)
        r = out['result']
        self.assertEqual(r['DUR'], 3.0)
        self.assertEqual(r['premix'][-3:], ['-c:a', 'pcm_f32le', 'f/audio/premix.wav'])
        self.assertEqual(r['measure'][-6:], ['f/audio/premix.wav', '-af', 'loudnorm=I=-15:print_format=json', '-f', 'null', '-'])

    def test_by_default_the_premix_goes_to_a_work_file_and_the_first_loudness_measurement_is_planned(self):
        code, out = ask({'cue_sheet': SHEET, 'film_folder': 'f', 'sound_folder': 's'})
        self.assertEqual(code, 0, out)
        r = out['result']
        self.assertEqual(r['method'], 'linear-two-pass')
        self.assertEqual(r['premix'][-3:], ['-c:a', 'pcm_f32le', 'f/audio/premix-raw.wav'])
        self.assertEqual(r['measure'][-5:], ['-af', 'loudnorm=I=-14.5:TP=-1.5:LRA=20:print_format=json', '-f', 'null', '-'])
        self.assertEqual(r['out'], 'f/assets/soundtrack.wav')

    def test_refusals_say_what_to_give(self):
        self.assertIn('cue_sheet', ask({})[1]['error'])
        self.assertIn('settings.duration', ask({'cue_sheet': [{'t': 0, 'sound': 'a', 'gain_db': 0}]})[1]['error'])
        self.assertIn('loudness.method', ask({'cue_sheet': SHEET, 'settings': {'loudness': {'method': 'loud'}}})[1]['error'])
        self.assertIn('Nothing to mix', ask({'cue_sheet': {'DUR': 2, 'cues': []}})[1]['error'])
        self.assertIn('[t, sound, gain_db]', ask({'cue_sheet': {'DUR': 2, 'cues': [[1, 'a']]}})[1]['error'])

    def test_a_music_input_opening_two_files_moves_the_next_numbers_on_by_two(self):
        two = {**MUSIC, 'input_args': ['-i', '{file}', '-i', '{sound}/music/air.wav'],
               'chain': "amix=inputs=2,atrim=0:{DUR}"}
        code, out = ask({'cue_sheet': SHEET, 'film_folder': 'f', 'sound_folder': 's', 'settings': {'music': two}})
        self.assertEqual(code, 0, out)
        argv = out['result']['premix']
        graph = argv[argv.index('-filter_complex') + 1]
        self.assertTrue(graph.startswith('[0:a]amix=inputs=2,atrim=0:6.0[m];[2:a]'), graph)
        self.assertIn('[6:a]aresample=48000,aformat=channel_layouts=stereo,volume=-9dB,adelay=4000|4000[s2]', graph)
        self.assertEqual(argv.count('-i'), 7)

    def test_a_cut_voice_line_is_skipped_and_the_others_keep_their_file_numbers(self):
        code, out = ask({'cue_sheet': {**SHEET, 'VO': [None, 1.5]}, 'film_folder': 'f', 'sound_folder': 's'})
        self.assertEqual(code, 0, out)
        argv = out['result']['premix']
        self.assertNotIn('f/assets/vo/l01.wav', argv)
        self.assertIn('f/assets/vo/l02.wav', argv)
        self.assertIn('[0:a]aresample=48000,aformat=channel_layouts=stereo,adelay=1500|1500[v1]', argv[argv.index('-filter_complex') + 1])
        self.assertEqual(out['result']['counts']['voice_lines'], 1)

    def test_a_settings_row_given_as_a_record_is_read_with_its_settings_as_text_and_a_retired_row_is_refused(self):
        rid = 'record:setting:motion-film-template~film~sample-film'
        row = {'id': rid, 'type': 'record:setting', 'value': {'name': 'sample', 'tool': 'tool:premix-a-motion-films-soundtrack',
               'scope_kind': 'film', 'scope_id': 'sample-film', 'settings': json.dumps({'duration': 9, 'gain': {'base': -4}}),
               'from': 'made-up@0000000', 'status': 'active'}}
        code, out = ask({'cue_sheet': {'cues': [[0, 'tick', -3]]}, 'settings_record': row, 'settings': {'gain': {'duck': -2}}})
        self.assertEqual(code, 0, out)
        self.assertEqual(out['result']['DUR'], 9.0)
        retired = {**row, 'value': {**row['value'], 'status': 'retired'}}
        self.assertIn('retired', ask({'cue_sheet': SHEET, 'settings_record': retired})[1]['error'])
        self.assertIn('run-with-settings', ask({'cue_sheet': SHEET, 'settings_record': rid})[1]['error'])

    def test_the_settings_from_the_wrapper_are_named_in_the_answer(self):
        code, out = ask({'cue_sheet': SHEET, 'settings_from': {'id': 'record:setting:motion-film-template~film~sample-film'}})
        self.assertEqual(code, 0, out)
        self.assertEqual(out['result']['settings_from']['id'], 'record:setting:motion-film-template~film~sample-film')


@unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg is not installed here')
class RunTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.film, self.sound = self.dir / 'films' / 'sample', self.dir / 'sound'
        for rel, secs, hz in [('sound/music/bed.wav', 12, 220), ('sound/palette/whoosh.wav', 0.3, 600),
                              ('sound/palette/tick.wav', 0.2, 900), ('sound/palette/chime.wav', 0.5, 1200),
                              ('films/sample/assets/vo/l01.wav', 1.5, 300), ('films/sample/assets/vo/l02.wav', 1.2, 330)]:
            (self.dir / rel).parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={hz}:duration={secs}',
                            str(self.dir / rel)], check=True)
        (self.film / 'audio').mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def run_method(self, loudness):
        code, out = ask({'cue_sheet': SHEET, 'film_folder': str(self.film), 'sound_folder': str(self.sound), 'run': True,
                         'settings': {'music': MUSIC, 'gain': {'base': -6, 'duck': -8}, 'loudness': loudness,
                                      'after_mix': None if loudness['method'] != 'none' else 'loudnorm=I=-14:TP=-1.5:LRA=11'}})
        self.assertEqual(code, 0, out)
        wav = self.film / 'assets' / 'soundtrack.wav'
        self.assertTrue(wav.exists())
        d = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(wav)],
                                 capture_output=True, text=True).stdout)
        self.assertAlmostEqual(d, 6.0, places=2)
        self.assertFalse((self.film / 'audio' / 'premix-raw.wav').exists())
        return out['result']

    def test_one_pass(self):
        self.run_method({'method': 'none'})

    def test_gain_then_limit(self):
        r = self.run_method({'method': 'gain-then-limit', 'measure': 'loudnorm=I=-15:TP=-1.5:LRA=11:print_format=json',
                             'target_i': -15.0, 'limiter': 'alimiter=limit=0.66:attack=1:release=60:level=disabled'})
        self.assertIn('gain_db', r)

    def test_linear_two_pass(self):
        r = self.run_method({'method': 'linear-two-pass', 'loudnorm': 'I=-14.5:TP=-1.5:LRA=20', 'target_i': -14.5, 'limit_db': -1.9})
        self.assertIn('output_i', r)


if __name__ == '__main__':
    unittest.main()
