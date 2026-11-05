"""token_table_from_parts.py on made-up words: kept and slot parts, ids, the slot bookkeeping, the notes, the file it writes,
the layered request files and every refusal. Run: python3 -I test/test_token_table_from_parts.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DO_WORK = os.path.join(os.path.dirname(HERE), 'do-work')
sys.path.insert(0, DO_WORK)
import token_table_from_parts as tt  # noqa: E402

SLOTS = {'WHO': ['PERSON', 'who the line is about'], 'WHEN': ['TIME', 'how long ago'], 'UNUSED': ['X', 'never used']}
PARTS = [['K', 'Meet the'], ['S', 'WHO', 'baker, Sam Example'], ['K', 'who rose early.'], ['S', 'WHEN', 'Two days ago.']]


def table(**kw):
    args = dict(pid='p1', t0=1.5, t1=4.0, parts=PARTS, slots=SLOTS, source='a made-up file', registry='registry.json', dim='speech.word')
    args.update(kw)
    return tt.build(**args)


class BuildTest(unittest.TestCase):
    def test_every_word_is_a_token_marked_keep_or_slot_in_order(self):
        t = table()
        self.assertEqual([x['dims']['speech.word'] for x in t['tokens']],
                         ['Meet', 'the', 'baker,', 'Sam', 'Example', 'who', 'rose', 'early.', 'Two', 'days', 'ago.'])
        self.assertEqual([x['mark'] for x in t['tokens']], ['KEEP'] * 2 + ['SLOT'] * 3 + ['KEEP'] * 3 + ['SLOT'] * 3)
        self.assertEqual([x['id'] for x in t['tokens']], [f'u1/speech/{n}' for n in range(11)])
        self.assertEqual(t['lines'], [{'id': 'speech.word:L1', 'dim': 'speech.word', 'job': None, 'tokens': [x['id'] for x in t['tokens']]}])

    def test_slot_tokens_carry_the_slot_and_only_used_slots_are_listed(self):
        t = table()
        sam = t['tokens'][3]
        self.assertEqual((sam['slot'], sam['slot_type'], sam['slot_note'], sam['slot_dims']), ('WHO', 'PERSON', 'who the line is about', ['speech.word']))
        self.assertNotIn('slot', t['tokens'][0])
        self.assertEqual(sorted(t['slots']), ['WHEN', 'WHO'])
        self.assertEqual(t['slots']['WHO'], {'type': 'PERSON', 'note': 'who the line is about', 'rule': 'hand'})

    def test_piece_unit_notes_and_provenance(self):
        t = table(unit_id='c9', notes={'note': 'made up'}, medium='audio', kind='draft', reader='by hand', by='the test')
        self.assertEqual(t['schema'], 'word-template@1')
        self.assertEqual(t['piece'], {'id': 'p1', 'medium': 'audio', 'kind': 'draft', 'built_from': [{'reader': 'by hand', 'path': 'a made-up file'}],
                                      'provenance': [{'op': 'hand_token_table', 'by': 'the test'}]})
        self.assertEqual(t['units'], [{'id': 'c9', 'kind': 'shot', 't0': 1.5, 't1': 4.0, 'order': 1}])
        self.assertEqual(t['tokens'][0]['unit'], 'c9')
        self.assertEqual(t['tokens'][0]['record'], 'c9.p1')
        self.assertEqual(t['notes'], {'language': 'en', 'note': 'made up'})
        self.assertEqual(t['registry'], 'registry.json')
        self.assertEqual(t['pending'][0]['dim'], 'drift.status')

    def test_a_slot_part_naming_an_unknown_slot_is_refused(self):
        with self.assertRaisesRegex(tt.Refusal, 'SLOT must be a key of slots'):
            table(parts=[['S', 'NOPE', 'x y']])
        with self.assertRaisesRegex(tt.Refusal, 'a slot part is'):
            table(parts=[['S', 'WHO']])


class RunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def request(self, **kw):
        r = {'out': os.path.join(self.tmp, 'out'), 'registry': 'registry.json', 'dim': 'speech.word',
             'templates': [{'name': 'first', 't0': 0, 't1': 2, 'source': 's', 'parts': [['K', 'one two']], 'slots': {}},
                           {'name': 'second', 'piece_id': 'second-piece', 't0': 0, 't1': 2, 'source': 's', 'parts': PARTS, 'slots': SLOTS}]}
        r.update(kw)
        return r

    def test_run_writes_one_file_per_template_named_by_name(self):
        written = tt.run(self.request())
        self.assertEqual([(os.path.basename(w['file']), w['tokens'], w['slots']) for w in written],
                         [('first.template.json', 2, 0), ('second.template.json', 11, 2)])
        with open(written[1]['file'], encoding='utf-8') as f:
            self.assertEqual(json.load(f)['piece']['id'], 'second-piece')
        with open(written[0]['file'], encoding='utf-8') as f:
            self.assertEqual(json.load(f)['piece']['id'], 'first')

    def test_missing_request_keys_are_refused_by_name(self):
        r = self.request()
        del r['dim']
        with self.assertRaisesRegex(tt.Refusal, 'no "dim"'):
            tt.run(r)
        r = self.request()
        del r['templates'][0]['parts']
        with self.assertRaisesRegex(tt.Refusal, 'no "parts"'):
            tt.run(r)

    def test_the_command_lays_request_files_over_each_other_and_prints_one_answer(self):
        settings, run_paths = os.path.join(self.tmp, 'settings.json'), os.path.join(self.tmp, 'paths.json')
        r = self.request()
        out = r.pop('out')
        with open(settings, 'w') as f:
            json.dump(r, f)
        with open(run_paths, 'w') as f:
            json.dump({'out': out}, f)
        done = subprocess.run([sys.executable, '-I', os.path.join(DO_WORK, 'token_table_from_parts.py'), '--request', settings, '--request', run_paths],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(json.loads(done.stdout.strip().splitlines()[-1])['result']['written']), 2)
        self.assertTrue(os.path.isfile(os.path.join(out, 'second.template.json')))

    def test_the_command_reads_standard_input_and_says_what_to_change(self):
        done = subprocess.run([sys.executable, '-I', os.path.join(DO_WORK, 'token_table_from_parts.py')], input=json.dumps({'out': self.tmp}),
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)
        self.assertIn('no "dim"', json.loads(done.stdout.strip().splitlines()[-1])['error'])

    def test_without_a_registry_the_shipped_one_is_named(self):
        r = self.request()
        del r['registry']
        tt.run(r)
        with open(os.path.join(self.tmp, 'out', 'first.template.json'), encoding='utf-8') as f:
            self.assertEqual(json.load(f)['registry'], tt.SHIPPED_REGISTRY)

    def test_a_registry_kept_in_the_settings_row_is_named_by_the_row_the_way_make_template_does(self):
        r = self.request()
        r['registry'] = {'dimensions': []}
        with self.assertRaisesRegex(tt.Refusal, 'no settings row names it'):
            tt.run(r)
        row_id = 'record:setting:fill-a-template-without-changing-its-words~piece~sample'
        row = {'id': row_id, 'type': 'record:setting', 'value': {
            'name': 'made up', 'tool': 'tool:write-a-word-template-from-the-words-i-keep-and-the-slots', 'scope_kind': 'piece',
            'scope_id': 'sample', 'settings': json.dumps(dict(r, out=None)), 'from': 'made up', 'status': 'active'}}
        other = dict(row, id='record:setting:fill-a-template-without-changing-its-words~account~main',
                     value=dict(row['value'], scope_kind='account', scope_id='main', tool='tool:make-a-word-template',
                                settings=json.dumps({'registry': {'dimensions': []}})))
        done = subprocess.run([sys.executable, '-I', os.path.join(DO_WORK, 'token_table_from_parts.py')],
                              input=json.dumps({'settings_record': [other, row], 'scope': 'piece:sample', 'out': os.path.join(self.tmp, 'o2')}),
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        with open(os.path.join(self.tmp, 'o2', 'first.template.json'), encoding='utf-8') as f:
            self.assertEqual(json.load(f)['registry'], 'setting:' + row_id)


if __name__ == '__main__':
    unittest.main()
