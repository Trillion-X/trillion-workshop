"""Runs the tool's commands for real on a made-up project built by synthetic_prproj.py.

Covers: cut, move, assemble and insert (files and a placeholder, with a new track), the structural checks, the
record of written outputs (--written) that guards an existing output, the refusals, compile_edit_plan.py turning an
EDIT-PLAN into ops, validate.py, prdump.py and proxy_render.py. Inserting files and the proxy need ffmpeg.
"""
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(os.path.dirname(HERE), 'do-work')
sys.path.insert(0, HERE)
sys.path.insert(0, WORK)
import synthetic_prproj  # noqa: E402
from prproj import Project, read_text  # noqa: E402

FFMPEG = shutil.which('ffmpeg') and shutil.which('ffprobe')
try:
    import blake3
except ImportError:
    blake3 = None


def run(script, *argv):
    out = subprocess.run([sys.executable, '-I', os.path.join(WORK, script), *map(str, argv)],
                         capture_output=True, text=True)
    return out


def write_json(path, value):
    with open(path, 'w') as f:
        json.dump(value, f)


def read_bytes(path):
    with open(path, 'rb') as f:
        return f.read()


def answer(out):
    return json.loads(out.stdout.strip().split('\n')[-1])


def v1(path):
    """[(clip name, start frame, end frame)] on V1 of the only sequence."""
    p = Project(read_text(path))
    tracks, tpf = p.tracks(p.sequences()[0])
    return {label: [(p.item_name(c), s // tpf, e // tpf) for _, s, e, c in p.track_items(uid)]
            for label, uid in tracks.items()}


class EditACopy(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='edit-a-copy-')
        self.input = os.path.join(self.dir, 'made-up.prproj')
        synthetic_prproj.write(self.input)
        self.input_bytes = read_bytes(self.input)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def plan(self, ops, name='plan.json', **extra):
        path = os.path.join(self.dir, name)
        write_json(path, {'project': self.input, 'ops': ops, **extra})
        return path

    def out(self, name='out.prproj'):
        return os.path.join(self.dir, name)

    def test_cut_and_move_write_a_checked_copy_and_record_it(self):
        plan = self.plan([
            {'op': 'cut', 'range': {'from': '00:00:02:00', 'to': '00:00:04:00'}},
            {'op': 'move', 'range': {'clip': 'A002', 'src_in': 10, 'src_out': 12},
             'to': {'before': {'clip': 'A001', 'src_in': 0, 'src_out': 1}}}])
        written = os.path.join(self.dir, 'film', 'written.json')
        os.makedirs(os.path.dirname(written))
        r = run('premiere_insert.py', plan, '--output', self.out(), '--written', written)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        res = answer(r)['result']
        self.assertEqual(res['length'], '00:00:18:00')
        tl = v1(self.out())
        self.assertEqual([(n, a, b) for n, a, b in tl['V1']][0], ('A002.mov', 0, 48))
        self.assertEqual(len(tl['V1']), 5)
        self.assertEqual([n for n, _, _ in tl['A1']], [n for n, _, _ in tl['V1']], 'sound follows picture')
        self.assertEqual(read_bytes(self.input), self.input_bytes, 'the input is never written')
        with open(written) as f:
            record = json.load(f)
        self.assertEqual(list(record), [self.out()])
        if blake3:
            self.assertEqual(record[self.out()], blake3.blake3(read_bytes(self.out())).hexdigest())
        self.assertEqual(run('validate.py', self.out()).stdout.strip().split('\n'),
                         run('validate.py', self.input).stdout.strip().split('\n'), 'no new structural problems')
        text = gzip.decompress(read_bytes(self.out())).decode()
        self.assertNotEqual(text.split('<MZ.Project.GUID>')[1][:36],
                            read_text(self.input).split('<MZ.Project.GUID>')[1][:36], 'a new project identity')

    def test_an_existing_output_is_replaced_only_when_the_record_says_this_tool_wrote_it(self):
        plan = self.plan([{'op': 'cut', 'range': {'from': '00:00:01:00', 'to': '00:00:02:00'}}])
        written = os.path.join(self.dir, 'written.json')
        first = run('premiere_insert.py', plan, '--output', self.out(), '--written', written)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        again = run('premiere_insert.py', plan, '--output', self.out(), '--written', written)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIsNotNone(answer(again)['result']['replaced'])
        no_record = run('premiere_insert.py', plan, '--output', self.out())
        self.assertEqual(no_record.returncode, 1)
        self.assertIn('not the file this tool last wrote', answer(no_record)['error'])
        with open(self.out(), 'ab') as f:
            f.write(b'saved by someone else')
        edited = run('premiere_insert.py', plan, '--output', self.out(), '--written', written)
        self.assertEqual(edited.returncode, 1)
        self.assertIn('write to a new name', answer(edited)['error'])

    def test_refusals_say_what_to_change(self):
        plan = self.plan([{'op': 'cut', 'range': {'from': '00:00:01:00', 'to': '00:00:02:00'}}])
        same = run('premiere_insert.py', plan, '--output', self.input)
        self.assertIn('never the input project', answer(same)['error'])
        nowhere = os.path.join(self.dir, 'bare.json')
        write_json(nowhere, {'ops': []})
        self.assertIn('--project and --output', answer(run('premiere_insert.py', nowhere))['error'])
        late = self.plan([{'op': 'cut', 'range': {'from': '00:00:01:00', 'to': '00:00:02:00'}},
                          {'op': 'insert', 'id': 'x', 'at': '00:00:05:00',
                           'pieces': [{'placeholder': 'MADE-UP', 'seconds': 1, 'track': 'V2'}]}], 'late.json')
        self.assertIn('original timecodes cannot follow', answer(run('premiere_insert.py', late, '--output', self.out()))['error'])
        no_track = self.plan([{'op': 'insert', 'id': 'x', 'at': 10,
                               'pieces': [{'placeholder': 'MADE-UP', 'seconds': 1, 'track': 'V3'}]}], 'nt.json')
        self.assertIn('"create_tracks": true', answer(run('premiere_insert.py', no_track, '--output', self.out()))['error'])
        missing = self.plan([{'op': 'move', 'range': {'clip': 'Z999', 'src_in': 0, 'src_out': 1}, 'to': 0}], 'm.json')
        self.assertIn('one unbroken run', answer(run('premiere_insert.py', missing, '--output', self.out()))['error'])
        self.assertFalse(os.path.exists(self.out()))

    def test_placeholder_on_a_new_track_then_assemble(self):
        plan = self.plan([
            {'op': 'insert', 'id': 'p2', 'at': '00:00:12:00',
             'pieces': [{'placeholder': 'MADE-UP PLACEHOLDER', 'seconds': 2.0, 'track': 'V3'}]},
            {'op': 'assemble', 'entries': [{'insert': 'p2'}, {'clip': 'A001', 'src_in': 0, 'src_out': 3}]}],
            create_tracks=True)
        r = run('premiere_insert.py', plan, '--output', self.out())
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        tl = v1(self.out())
        self.assertEqual(tl['V3'], [('MADE-UP PLACEHOLDER', 0, 48)])
        self.assertEqual(tl['V1'], [('A001.mov', 48, 120)])
        self.assertEqual(tl['A1'], [('A001.mov', 48, 120)])
        self.assertIn('added video track V3', r.stdout)

    @unittest.skipUnless(FFMPEG, 'needs ffmpeg and ffprobe')
    def test_insert_files_opens_a_gap_on_every_track_and_the_proxy_renders(self):
        plate, voice = os.path.join(self.dir, 'plate.mp4'), os.path.join(self.dir, 'voice.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=640x360:r=24000/1001',
                        '-frames:v', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', plate], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-ac', '2', '-ar', '48000',
                        voice], check=True)
        plan = self.plan([{'op': 'insert', 'id': 'p1', 'at': '00:00:05:00',
                           'pieces': [{'file': plate, 'track': 'V2'}, {'file': voice, 'track': 'A2'}]}])
        r = run('premiere_insert.py', plan, '--output', self.out())
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        tl = v1(self.out())
        self.assertEqual(tl['V2'], [('plate.mp4', 120, 144)])
        self.assertEqual(tl['A2'], [('voice.wav', 120, 144)])
        self.assertEqual([(a, b) for _, a, b in tl['V1']], [(0, 120), (144, 264), (264, 504)])
        mono = os.path.join(self.dir, 'mono.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=1', '-ac', '1', mono], check=True)
        bad = self.plan([{'op': 'insert', 'id': 'm', 'at': 0, 'pieces': [{'file': mono, 'track': 'A2'}]}], 'bad.json')
        self.assertIn('only stereo', answer(run('premiere_insert.py', bad, '--output', self.out('bad.prproj')))['error'])
        proxy = os.path.join(self.dir, 'proxy.mp4')
        pr = run('proxy_render.py', self.out(), proxy, '--from', '00:00:04:00', '--to', '00:00:07:00', '--height', '180')
        self.assertEqual(pr.returncode, 0, pr.stdout + pr.stderr)
        seconds = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
                                        proxy], capture_output=True, text=True).stdout)
        self.assertAlmostEqual(seconds, 3.0, delta=0.2)

    def test_compile_edit_plan_trims_pauses_and_places_inserts(self):
        transcripts = os.path.join(self.dir, 'words')
        os.makedirs(transcripts)
        words = [{'type': 'word', 'start': s, 'end': e} for s, e in
                 ((0.2, 0.6), (0.7, 1.1), (3.1, 3.5), (3.6, 4.0), (5.5, 5.9))]
        write_json(os.path.join(transcripts, 'A001.json'), {'words': words})
        write_json(os.path.join(transcripts, 'A002.json'), {'words': [{'type': 'word', 'start': 6.0, 'end': 9.0}]})
        edit_plan = os.path.join(self.dir, 'EDIT-PLAN.json')
        write_json(edit_plan, {'project': self.input, 'new_order': [
            {'id': 'R2', 'clip': 'A002', 'src_in': 6.0, 'src_out': 9.0},
            {'id': 'PIECE-g1'},
            {'id': 'R1', 'clip': 'A001', 'src_in': 0.0, 'src_out': 6.0, 'inner_cuts': [{'src_in': 3.55, 'src_out': 3.58}]},
            {'id': 'PIECE-nope'}],
            'inserts': [{'id': 'g1', 'at': '00:00:20:00',  # at the end, so it rides in no source range
                         'pieces': [{'placeholder': 'MADE-UP GAP', 'seconds': 1.0, 'track': 'V2'}]}]})
        ops = os.path.join(self.dir, 'ops.json')
        r = run('compile_edit_plan.py', edit_plan, '--transcripts', transcripts, '--output', self.out(),
                '--plan-out', ops, '--insert-prefix', 'PIECE-')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        with open(ops) as f:
            plan = json.load(f)
        self.assertEqual([o['op'] for o in plan['ops']], ['insert', 'assemble'])
        entries = plan['ops'][1]['entries']
        self.assertEqual(entries[1], {'insert': 'g1', 'label': 'PIECE-g1'})
        r1 = [e for e in entries if e.get('label', '').startswith('R1')]
        # two long pauses (1.1-3.1 and 4.0-5.5) keep 0.4 s; the inner cut splits the middle
        self.assertEqual([(e['src_in'], e['src_out']) for e in r1],
                         [(0.0, 1.3), (2.9, 3.55), (3.58, 4.2), (5.3, 6.0)])
        self.assertTrue(any('PIECE-nope: left out' in n for n in plan['notes']))
        run_it = run('premiere_insert.py', ops)
        self.assertEqual(run_it.returncode, 0, run_it.stdout + run_it.stderr)
        tl = v1(self.out())
        self.assertEqual(tl['V1'][0][0], 'A002.mov')
        self.assertEqual(tl['V2'], [('MADE-UP GAP', 72, 96)])

    def test_validate_and_prdump(self):
        text = read_text(self.input)
        broken = os.path.join(self.dir, 'broken.prproj')
        with open(broken, 'w') as f:
            f.write(text.replace('<Clip ObjectRef="', '<Clip ObjectRef="9999', 1))
        v = run('validate.py', broken)
        self.assertEqual(v.returncode, 1)
        self.assertIn('dangling ObjectRef', v.stdout)
        d = run('prdump.py', self.input, '00:00:09:00', '00:00:11:00')
        self.assertEqual(d.returncode, 0, d.stderr)
        self.assertIn('SEQUENCE Main cut', d.stdout)
        self.assertIn('A002.mov  src 5.005-15.015', d.stdout)


if __name__ == '__main__':
    unittest.main()
