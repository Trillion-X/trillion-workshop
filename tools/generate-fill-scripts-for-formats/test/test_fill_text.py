"""The template filling, word counts, holes, pages and index of generate-fill-scripts-for-formats, on a made-up tea shop's batch."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'read-data'))
sys.path.insert(1, str(HERE.parents[1] / 'settings' / 'read-data'))
import fill_records  # noqa: E402
import fill_text  # noqa: E402
import settings  # noqa: E402

COMMAND = HERE.parent / 'do-work' / 'generate_fills.py'


def sample_request():
    return json.loads((HERE / 'sample-request.json').read_text(encoding='utf-8'))


class Counting(unittest.TestCase):
    def test_a_hole_shows_its_label_and_counts_its_words(self):
        text = 'We brewed <<3|the real count|the till roll>> pots today.'
        self.assertEqual(fill_text.render(text), 'We brewed [the real count] pots today.')
        self.assertEqual(fill_text.holes(text), [('the real count', 'the till roll')])
        self.assertEqual(fill_text.words(text), 7)

    def test_marks_alone_are_not_words(self):
        self.assertEqual(fill_text.words('Tea - now / here ...'), 3)

    def test_quoted_words_count_only_what_is_on_screen(self):
        text = '(card slides in) "Warm pot" and <<2|price|the menu>> (zoom) "<<1|day|the board>> only"'
        self.assertEqual(fill_text.quoted_words(text), 2 + 2 + 2)

    def test_a_cell_keeps_its_pipes(self):
        self.assertEqual(fill_text.escape_cell('a | b'), 'a \\| b')


class Templates(unittest.TestCase):
    ctx = {'cap': {'name': 'Steeper', 'tags': ['green', 'black'], 'none': '', 'line': 'Lantern: it steeps for you',
                   'habit': 'brewing it myself'}, 'v': {}}

    def test_paths_fill_and_an_empty_path_is_refused_by_name(self):
        self.assertEqual(fill_text.evaluate('Meet {cap.name}, first {cap.tags.0}.', self.ctx), 'Meet Steeper, first green.')
        with self.assertRaisesRegex(fill_text.TemplateError, r'\{cap\.missing\}'):
            fill_text.evaluate('{cap.missing}', self.ctx)

    def test_if_each_replace_after_concat(self):
        ev = fill_text.evaluate
        self.assertEqual(ev({'if': 'cap.none', 'then': 'yes', 'else': 'no'}, self.ctx), 'no')
        self.assertIsNone(ev({'if': 'cap.none', 'then': 'yes'}, self.ctx))
        self.assertEqual(ev({'each': 'cap.tags', 'as': 't', 'item': '"{t}"', 'sep': ' -> '}, self.ctx), '"green" -> "black"')
        self.assertEqual(ev({'each': 'cap.tags', 'as': 't', 'item': '- {t}'}, self.ctx), ['- green', '- black'])
        self.assertEqual(ev({'each': 'cap.nothing', 'item': 'x', 'empty': 'none yet'}, self.ctx), 'none yet')
        self.assertEqual(ev({'replace': '{cap.habit}', 'old': ' myself', 'new': ''}, self.ctx), 'brewing it')
        self.assertEqual(ev({'after': '{cap.line}', 'sep': ': '}, self.ctx), 'it steeps for you')
        self.assertEqual(ev({'concat': ['A ', {'if': 'cap.name', 'then': '{cap.name}'}, '.']}, self.ctx), 'A Steeper.')

    def test_an_unknown_template_or_a_missing_separator_is_refused(self):
        with self.assertRaisesRegex(fill_text.TemplateError, 'one of if, each'):
            fill_text.evaluate({'loop': 1}, self.ctx)
        with self.assertRaisesRegex(fill_text.TemplateError, 'no .: . to cut after'):
            fill_text.evaluate({'after': '{cap.name}', 'sep': ': '}, self.ctx)

    def test_a_page_adds_list_lines_and_drops_nothing(self):
        self.assertEqual(fill_text.page(['# {cap.name}', {'if': 'cap.none', 'then': 'x'}, {'each': 'cap.tags', 'as': 't', 'item': '{t}'}],
                                        self.ctx), '# Steeper\ngreen\nblack\n')


class Filling(unittest.TestCase):
    def setUp(self):
        self.request = sample_request()
        self.answer = fill_text.fill_all(self.request)
        self.by = {(f['format'], f['capability']): f for f in self.answer['fills']}

    def test_every_format_is_filled_with_every_capability(self):
        self.assertEqual(self.answer['count'], 4)
        self.assertEqual(sorted(self.by), [('counter-chat', 'cold-brew'), ('counter-chat', 'steeper'),
                                           ('silent-card', 'cold-brew'), ('silent-card', 'steeper')])
        self.assertEqual(self.by[('counter-chat', 'steeper')]['file'], 'counter-chat/steeper.md')

    def test_words_budget_and_holes(self):
        steeper = self.by[('counter-chat', 'steeper')]
        # L1 "Hi, today I'm showing you Steeper." 6; L2 the 6-word pain, "It got me", a 3-word hole and "Then it got better." 16
        self.assertEqual((steeper['words'], steeper['budget']), (22, 20))
        # one hole in a line, one in the note, one in a slot, and the standard hole
        self.assertEqual(steeper['holes'], 4)
        text = steeper['text']
        self.assertIn("| 1 | 1 | Hi, today I'm showing you Steeper. | 8 | 6 | -2 |  2.5 |", text)
        self.assertIn('| [the real count] | line 2 | the till roll for one morning |', text)
        self.assertIn('| [opening day] | note | the shop\'s own calendar |', text)
        self.assertIn('| [first pour] | slot 2 | a real pour on the day |', text)
        self.assertIn('| [real run of tool:steeper] | every screen | one real run |', text)

    def test_over_budget_lines_are_named(self):
        steeper = self.by[('counter-chat', 'steeper')]['text']
        self.assertIn('Over budget: L2.', steeper)
        cold = self.by[('counter-chat', 'cold-brew')]['text']
        self.assertIn('No line is over budget.', cold)

    def test_a_capability_without_steps_and_without_a_name_takes_the_else_words(self):
        cold = self.by[('counter-chat', 'cold-brew')]['text']
        self.assertIn("Hi, today I'm showing you a Lantern recipe.", cold)
        self.assertIn('the recipe card, then the jug', cold)
        steeper = self.by[('counter-chat', 'steeper')]['text']
        self.assertIn('"Warm the pot" -> "Steep" -> "Pour"', steeper)

    def test_on_screen_count_and_the_other_capabilities(self):
        card = self.by[('silent-card', 'steeper')]
        self.assertIn('"Cold brew overnight"', card['text'])
        self.assertNotIn('badge "Steeper" / "Steeper"', card['text'])
        # "Steeper" 1 + "Cold brew overnight" 3, and the stage direction is not counted
        self.assertEqual(card['words'], 4)

    def test_the_index_puts_every_fill_in_the_matrix_and_adds_the_buckets(self):
        index = self.answer['index']['text']
        self.assertIn('| capability | counter | card |', index)
        self.assertIn('|---|---|---|', index)
        self.assertIn('| "Steeper" | [22/20](counter-chat/steeper.md) | [4/6](silent-card/steeper.md) |', index)
        self.assertIn('| Recipes | 7 |', index)
        self.assertIn('| Kettles | 2 |', index)
        self.assertIn('Total: 9.', index)

    def test_a_request_lacking_parts_is_refused_with_what_to_give(self):
        bad = dict(self.request)
        del bad['listings']
        with self.assertRaisesRegex(fill_text.TemplateError, 'no "listings"'):
            fill_text.fill_all(bad)
        bad = json.loads(json.dumps(self.request))
        bad['capabilities'][0]['id'] = 'tool:unknown'
        with self.assertRaisesRegex(fill_text.TemplateError, "names listing 'tool:unknown'"):
            fill_text.fill_all(bad)
        bad = json.loads(json.dumps(self.request))
        bad['formats'][0]['template']['count'] = 'syllables'
        with self.assertRaisesRegex(fill_text.TemplateError, 'use one of words, quoted-words'):
            fill_text.fill_all(bad)


def as_rows(request):
    """The sample request as the list rows a person's account would hold."""
    return [{**r, 'id': 'record:library:' + r['id'], 'type': 'record:library'} for r in fill_records.rows_from_request(request, 'tea')]


class FromRows(unittest.TestCase):
    def test_rows_give_the_same_request(self):
        request = sample_request()
        self.assertEqual(fill_records.request_from_rows(as_rows(request), 'fill-batch-tea'), request)

    def test_each_row_is_one_object_with_its_kind_and_title(self):
        rows = {r['id']: r['value'] for r in as_rows(sample_request())}
        self.assertEqual(sorted(rows), ['record:library:catalog-listing-tool-steeper', 'record:library:catalog-listing-workflow-cold-brew',
                                        'record:library:fill-batch-tea', 'record:library:fill-capability-cold-brew',
                                        'record:library:fill-capability-steeper', 'record:library:fill-format-counter-chat',
                                        'record:library:fill-format-silent-card'])
        self.assertEqual(rows['record:library:catalog-listing-tool-steeper']['catalog_id'], 'tool:steeper')
        self.assertEqual(rows['record:library:fill-capability-steeper']['title'], 'tool:steeper')
        self.assertEqual(json.loads(rows['record:library:fill-batch-tea']['detail'])['formats'],
                         ['fill-format-counter-chat', 'fill-format-silent-card'])

    def test_a_missing_batch_or_row_is_named(self):
        rows = as_rows(sample_request())
        with self.assertRaisesRegex(fill_records.RowError, 'record:library:fill-batch-tea'):
            fill_records.request_from_rows(rows, 'fill-batch-coffee')
        without = [r for r in rows if not r['id'].endswith('cold-brew')]
        with self.assertRaisesRegex(fill_records.RowError, 'fill-capability-cold-brew'):
            fill_records.request_from_rows(without, 'tea')


class Command(unittest.TestCase):
    def run_command(self, *args, stdin=''):
        return subprocess.run([sys.executable, '-I', str(COMMAND), *args], input=stdin, capture_output=True, text=True)

    def test_one_request_in_one_answer_out(self):
        run = self.run_command(stdin=json.dumps(sample_request()))
        self.assertEqual(run.returncode, 0, run.stderr)
        answer = json.loads(run.stdout.strip().splitlines()[-1])
        self.assertEqual(answer['count'], 4)
        self.assertIn('# Fill: counter x "Steeper"', answer['fills'][0]['text'])

    def test_rows_on_standard_input_and_pages_written_under_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            export = Path(tmp) / 'export.json'
            export.write_text(json.dumps({'records': as_rows(sample_request())}))
            run = self.run_command('--records', str(export), '--batch', 'tea', '--out', str(Path(tmp) / 'pages'))
            self.assertEqual(run.returncode, 0, run.stderr)
            answer = json.loads(run.stdout.strip().splitlines()[-1])
            self.assertNotIn('text', answer['fills'][0])
            self.assertTrue((Path(tmp) / 'pages' / 'silent-card' / 'cold-brew.md').exists())
            self.assertTrue((Path(tmp) / 'pages' / 'INDEX.md').read_text().startswith('# Tea shop fills'))
            run = self.run_command(stdin=json.dumps({'rows': as_rows(sample_request()), 'batch': 'tea'}))
            self.assertEqual(json.loads(run.stdout.strip().splitlines()[-1])['count'], 4)

    def test_rows_out_writes_the_rows_that_fill_the_same_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'rows.json'
            run = self.run_command('--rows-out', str(out), '--batch', 'tea', stdin=json.dumps(sample_request()))
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads(run.stdout.strip().splitlines()[-1])['rows'], 7)
            rows = json.loads(out.read_text())['rows']
            again = self.run_command(stdin=json.dumps({'rows': rows, 'batch': 'tea'}))
            direct = self.run_command(stdin=json.dumps(sample_request()))
            self.assertEqual(again.stdout, direct.stdout)
            run = self.run_command('--rows-out', str(out), stdin=json.dumps(sample_request()))
            self.assertIn('needs --batch', json.loads(run.stdout.strip().splitlines()[-1])['error'])

    def test_a_refusal_is_one_json_line_with_what_to_do(self):
        run = self.run_command(stdin=json.dumps({'formats': []}))
        self.assertEqual(run.returncode, 2)
        self.assertIn('see the README', json.loads(run.stdout.strip().splitlines()[-1])['error'])


def split_settings(request, scope=('account', 'main'), status='active'):
    """The sample request with its settings, all but `fetched`, moved to a made-up list:settings row."""
    kept = {k: v for k, v in request['settings'].items() if k != 'fetched'}
    record = settings.make_record('generate-fill-scripts-for-formats', scope[0], scope[1], kept, name='Tea shop fill pages',
                                  tool='tool:generate-fill-scripts-for-formats', source='made-up@0', status=status)
    return {**request, 'settings': {'fetched': request['settings']['fetched']}}, record


class SettingsRow(unittest.TestCase):
    def run_command(self, *args, stdin=''):
        return subprocess.run([sys.executable, '-I', str(COMMAND), *args], input=stdin, capture_output=True, text=True)

    def last(self, run):
        return json.loads(run.stdout.strip().splitlines()[-1])

    def test_settings_from_the_row_fill_the_same_pages(self):
        request, record = split_settings(sample_request())
        direct = self.run_command(stdin=json.dumps(sample_request()))
        run = self.run_command(stdin=json.dumps({**request, 'settings_record': record}))
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(run.stdout, direct.stdout)

    def test_the_requests_own_settings_win_over_the_row(self):
        request, record = split_settings(sample_request())
        request['settings']['over_budget'] = {'ratio': 100, 'min_words': 100}
        answer = self.last(self.run_command(stdin=json.dumps({**request, 'settings_record': record})))
        self.assertTrue(all('Over budget' not in f['text'] for f in answer['fills']))

    def test_the_first_scope_with_a_row_is_read(self):
        request, account = split_settings(sample_request())
        film = json.loads(json.dumps(account))
        film['id'] = 'record:setting:generate-fill-scripts-for-formats~film~tea-film'
        film['value'].update(scope_kind='film', scope_id='tea-film')
        page = json.loads(film['value']['settings'])
        page['fill_page'] = ['# Film page for {cap.id}']
        film['value']['settings'] = json.dumps(page)
        given = {**request, 'settings_record': [account, film]}
        answer = self.last(self.run_command(stdin=json.dumps({**given, 'settings_scopes': [['film', 'tea-film'], ['account', 'main']]})))
        self.assertEqual(answer['fills'][0]['text'], '# Film page for tool:steeper\n')
        answer = self.last(self.run_command(stdin=json.dumps({**given, 'settings_scopes': [['film', 'other'], ['account', 'main']]})))
        self.assertIn('# Fill: counter x "Steeper"', answer['fills'][0]['text'])

    def test_a_missing_retired_or_foreign_row_is_refused_with_what_to_give(self):
        request, record = split_settings(sample_request())
        run = self.run_command(stdin=json.dumps({**request, 'settings_record': record, 'settings_scopes': [['person', 'someone']]}))
        self.assertEqual(run.returncode, 2)
        self.assertIn('record:setting:generate-fill-scripts-for-formats~<scope_kind>~<scope_id>', self.last(run)['error'])
        _, retired = split_settings(sample_request(), status='retired')
        self.assertIn('retired', self.last(self.run_command(stdin=json.dumps({**request, 'settings_record': retired})))['error'])
        foreign = json.loads(json.dumps(record))
        foreign['value']['tool'] = 'tool:some-other-tool'
        self.assertIn('not tool:generate-fill-scripts-for-formats',
                      self.last(self.run_command(stdin=json.dumps({**request, 'settings_record': foreign})))['error'])
        run = self.run_command(stdin=json.dumps({**request, 'settings_record': record, 'settings_scopes': 'account'}))
        self.assertIn('settings_scopes is a list', self.last(run)['error'])

    def test_rows_and_a_settings_file_leave_the_rows_only_what_the_row_lacks(self):
        request, record = split_settings(sample_request())
        with tempfile.TemporaryDirectory() as tmp:
            held = Path(tmp) / 'setting.json'
            held.write_text(json.dumps({'records': [record]}))
            out = Path(tmp) / 'rows.json'
            run = self.run_command('--rows-out', str(out), '--batch', 'tea', '--settings-record', str(held),
                                   stdin=json.dumps(sample_request()))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            rows = json.loads(out.read_text())['rows']
            batch = json.loads([r for r in rows if r['value']['kind'] == 'fill-batch'][0]['value']['detail'])
            self.assertEqual(batch['settings'], {'fetched': 'a made-up morning'})
            direct = self.run_command(stdin=json.dumps(sample_request()))
            again = self.run_command(stdin=json.dumps({'rows': rows, 'batch': 'tea', 'settings_record': record}))
            self.assertEqual(again.stdout, direct.stdout)
            export = Path(tmp) / 'export.json'
            export.write_text(json.dumps({'records': [{**r, 'id': 'record:library:' + r['id'], 'type': 'record:library'} for r in rows]}))
            again = self.run_command('--records', str(export), '--batch', 'tea', '--settings-record', str(held))
            self.assertEqual(again.stdout, direct.stdout)


if __name__ == '__main__':
    unittest.main()
