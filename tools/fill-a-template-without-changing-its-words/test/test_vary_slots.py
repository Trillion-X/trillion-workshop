"""vary_slots_one_at_a_time.py on made-up sentences: the base, one slot varying at a time, the script, shot and claims files,
a dropped sentence, the manifest and lines list, the layered request files and every refusal.
Run: python3 -I test/test_vary_slots.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DO_WORK = os.path.join(os.path.dirname(HERE), 'do-work')
sys.path.insert(0, DO_WORK)
import vary_slots_one_at_a_time as vs  # noqa: E402

FIXED = {'words': 'The shop opens at nine.', 'kind': 'claim', 'topics': ['hours'], 'facts': ['f-hours']}


def request(tmp):
    return {
        'slots': [
            {'name': 'LEAD', 'base': 'L1', 'candidates': {
                'L1': {'text': ', with a lamp on the counter', 'claim': {'facts': ['f-lamp']}},
                'L2': {'text': ', with two lamps', 'claim': {'facts': ['f-lamp', 'f-two']}},
                'L3': {'text': '', 'claim': {'facts': []}}}},
            {'name': 'BEAT', 'base': 'B1', 'candidates': {
                'B1': {'text': 'It is early.', 'claim': {'topics': ['timing']}},
                'B2': {'text': '', 'claim': None}}}],
        'sentences': [{'template': 'This is Alex Example{LEAD}.', 'claim_from': 'LEAD'},
                      {'template': '{BEAT}', 'claim_from': 'BEAT'},
                      {'template': 'The shop opens at nine.', 'claim': FIXED}],
        'id_prefix': 'open-',
        'script_path': 'scripts/{id}.txt',
        'shot_about': 'Candidate {variant} ({picks}) of {id}.',
        'claims_about': 'Claims of {id}.',
        'out': {'here': tmp, 'narrator': tmp}}


def read(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


class VaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.request = request(self.tmp)

    def test_the_base_then_each_other_candidate_one_slot_at_a_time(self):
        self.assertEqual(vs.picks_of(self.request), {
            'base': {'LEAD': 'L1', 'BEAT': 'B1'}, 'L2': {'LEAD': 'L2', 'BEAT': 'B1'}, 'L3': {'LEAD': 'L3', 'BEAT': 'B1'},
            'B2': {'LEAD': 'L1', 'BEAT': 'B2'}})

    def test_run_writes_a_script_a_shot_and_a_claims_file_for_every_variant(self):
        self.assertEqual(vs.run(self.request), ['base', 'L2', 'L3', 'B2'])
        with open(os.path.join(self.tmp, 'lines', 'open-base.txt'), encoding='utf-8') as f:
            self.assertEqual(f.read(), 'This is Alex Example, with a lamp on the counter. It is early. The shop opens at nine.\n')
        self.assertEqual(read(os.path.join(self.tmp, 'shots', 'open-l2.json')),
                         {'id': 'open-l2', '_about': 'Candidate L2 (L2, B1) of open-l2.', 'voice': {'script': 'scripts/open-l2.txt'}, 'screen': [], 'events': []})
        claims = read(os.path.join(self.tmp, 'claims', 'open-l2.json'))
        self.assertEqual(claims['_about'], 'Claims of open-l2.')
        self.assertEqual(claims['voice'][0], {'words': 'This is Alex Example, with two lamps.', 'kind': 'claim', 'facts': ['f-lamp', 'f-two']})
        self.assertEqual(claims['voice'][1], {'words': 'It is early.', 'kind': 'claim', 'topics': ['timing']})
        self.assertEqual(claims['voice'][2], FIXED)
        self.assertEqual(claims['screen'], [])

    def test_an_empty_sentence_is_left_out_with_its_claim_and_an_empty_slot_leaves_the_rest(self):
        vs.run(self.request)
        dropped = read(os.path.join(self.tmp, 'claims', 'open-b2.json'))['voice']
        self.assertEqual([c['words'] for c in dropped], ['This is Alex Example, with a lamp on the counter.', 'The shop opens at nine.'])
        bare = read(os.path.join(self.tmp, 'claims', 'open-l3.json'))['voice']
        self.assertEqual(bare[0]['words'], 'This is Alex Example.')

    def test_the_manifest_and_the_lines_list_follow_the_variants(self):
        vs.run(self.request)
        manifest = read(os.path.join(self.tmp, 'manifest.json'))
        self.assertEqual(list(manifest), ['base', 'L2', 'L3', 'B2'])
        self.assertEqual(manifest['B2'], {'shot': 'open-b2', 'slots': {'LEAD': 'L1', 'BEAT': 'B2'},
                                          'line': 'This is Alex Example, with a lamp on the counter. The shop opens at nine.'})
        with open(os.path.join(self.tmp, 'lines.txt'), encoding='utf-8') as f:
            self.assertEqual(f.read().splitlines(), [m['line'] for m in manifest.values()])

    def test_refusals_say_what_to_change(self):
        r = self.request
        r['slots'][0]['base'] = 'L9'
        with self.assertRaisesRegex(vs.Refusal, 'base pick L9 is not one of its candidates'):
            vs.run(r)
        r = request(self.tmp)
        r['sentences'][0]['template'] = 'This is {NOBODY}.'
        with self.assertRaisesRegex(vs.Refusal, r'names the slot \{NOBODY\}'):
            vs.run(r)
        r = request(self.tmp)
        r['sentences'][1]['claim_from'] = 'NOBODY'
        with self.assertRaisesRegex(vs.Refusal, 'takes its claim from NOBODY'):
            vs.run(r)
        r = request(self.tmp)
        del r['id_prefix']
        with self.assertRaisesRegex(vs.Refusal, 'no "id_prefix"'):
            vs.run(r)
        r = request(self.tmp)
        del r['out']['narrator']
        with self.assertRaisesRegex(vs.Refusal, 'no out.narrator'):
            vs.run(r)

    def test_a_picked_candidate_with_words_but_no_claim_is_refused(self):
        r = request(self.tmp)
        r['slots'][1]['candidates']['B2'] = {'text': 'Said, but with no claim.', 'claim': None}
        with self.assertRaisesRegex(vs.Refusal, 'has no claim'):
            vs.run(r)

    def test_the_command_lays_request_files_over_each_other(self):
        r = request(self.tmp)
        out = r.pop('out')
        settings, paths = os.path.join(self.tmp, 'settings.json'), os.path.join(self.tmp, 'paths.json')
        with open(settings, 'w') as f:
            json.dump(r, f)
        with open(paths, 'w') as f:
            json.dump({'out': out}, f)
        done = subprocess.run([sys.executable, '-I', os.path.join(DO_WORK, 'vary_slots_one_at_a_time.py'), '--request', settings, '--request', paths],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout.strip().splitlines()[-1]), {'result': {'variants': 4, 'ids': ['base', 'L2', 'L3', 'B2']}})

    def test_the_settings_object_is_laid_under_the_request_on_standard_input(self):
        r = request(self.tmp)
        out = r.pop('out')
        body = {'settings': dict(r, id_prefix='ignored-'), 'id_prefix': 'open-', 'out': out}
        done = subprocess.run([sys.executable, '-I', os.path.join(DO_WORK, 'vary_slots_one_at_a_time.py')], input=json.dumps(body),
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(json.loads(done.stdout.strip().splitlines()[-1])['result']['ids'], ['base', 'L2', 'L3', 'B2'])
        self.assertTrue(os.path.exists(os.path.join(out['here'], 'lines', 'open-base.txt')), os.listdir(out['here']))

    def test_the_settings_wrapper_hands_the_settings_through(self):
        wrapper = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'settings', 'do-work', 'run-with-settings.mjs')
        if not os.path.exists(wrapper):
            self.skipTest('tools/settings is not in this checkout')
        r = request(self.tmp)
        out = r.pop('out')
        done = subprocess.run(['node', wrapper, '--folder', 'fill-a-template-without-changing-its-words', '--', sys.executable, '-I',
                               os.path.join(DO_WORK, 'vary_slots_one_at_a_time.py')], input=json.dumps({'settings': r, 'out': out}),
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(json.loads(done.stdout.strip().splitlines()[-1])['result']['variants'], 4)

    def run_with(self, body):
        done = subprocess.run([sys.executable, '-I', os.path.join(DO_WORK, 'vary_slots_one_at_a_time.py')], input=json.dumps(body),
                              capture_output=True, text=True)
        return done.returncode, json.loads(done.stdout.strip().splitlines()[-1])

    def record(self, settings, tool='tool:make-spoken-line-candidates-one-slot-at-a-time', status='active'):
        """A list:settings row as records:read gives it: settings as compact JSON text, the way make_record writes it."""
        return {'id': 'record:setting:fill-a-template-without-changing-its-words~piece~sample-opening', 'type': 'record:setting',
                'value': {'name': 'sample opening', 'tool': tool, 'scope_kind': 'piece', 'scope_id': 'sample-opening',
                          'settings': json.dumps(settings, sort_keys=True, separators=(',', ':')), 'from': 'made up', 'status': status}}

    def test_the_settings_row_itself_as_settings_record_and_the_requests_settings_over_it(self):
        r = request(self.tmp)
        out = r.pop('out')
        code, answer = self.run_with({'settings_record': self.record(dict(r, id_prefix='row-')), 'settings': {'id_prefix': 'own-'}, 'out': out})
        self.assertEqual(code, 0, answer)
        self.assertTrue(os.path.exists(os.path.join(out['here'], 'lines', 'own-base.txt')), os.listdir(out['here']))

    def test_a_row_for_another_tool_or_a_retired_row_is_refused(self):
        r = request(self.tmp)
        out = r.pop('out')
        code, answer = self.run_with({'settings_record': self.record(r, tool='tool:another'), 'out': out})
        self.assertEqual(code, 2)
        self.assertIn('not tool:make-spoken-line-candidates-one-slot-at-a-time', answer['error'])
        code, answer = self.run_with({'settings_record': self.record(r, status='retired'), 'out': out})
        self.assertEqual(code, 2)
        self.assertIn("'retired'", answer['error'])

    def test_a_settings_record_that_was_not_read_is_refused(self):
        done = subprocess.run([sys.executable, '-I', os.path.join(DO_WORK, 'vary_slots_one_at_a_time.py')],
                              input=json.dumps({'settings_record': 'record:setting:fill-a-template-without-changing-its-words~film~sample'}),
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)
        self.assertIn('run-with-settings.mjs', json.loads(done.stdout.strip().splitlines()[-1])['error'])

    def test_the_command_says_what_to_change_as_json_with_exit_2(self):
        done = subprocess.run([sys.executable, '-I', os.path.join(DO_WORK, 'vary_slots_one_at_a_time.py')], input=json.dumps({'slots': []}),
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)
        self.assertIn('no "sentences"', json.loads(done.stdout.strip().splitlines()[-1])['error'])


if __name__ == '__main__':
    unittest.main()
