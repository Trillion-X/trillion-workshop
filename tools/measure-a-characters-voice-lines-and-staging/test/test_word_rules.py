"""The running terms, the comments that name the character and their codes, judged by tools/judge-words, on the made-up
show of fixture_world.py. Needs node."""
import csv
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fixture_world import SETTINGS, json3, last, refused, run, write  # noqa: E402


@unittest.skipUnless(shutil.which('node'), 'needs node (the word judge is tools/judge-words)')
class WordRulesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.data = os.path.join(self.dir, 'show')
        self.yt = os.path.join(self.dir, 'youtube')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def ask(self, **fields):
        return {'data_folder': self.data, 'youtube_folder': self.yt, 'settings': SETTINGS, **fields}

    def test_terms_are_counted_per_line_with_first_last_and_an_example(self):
        write(os.path.join(self.data, 'catalog.tsv'), 'id\tformat\tdate\nvid-a\tepisode\t20300105\nvid-b\tepisode\t20300201\nvid-c\tepisode\t20300301\n')
        write(os.path.join(self.yt, 'captions', 'vid-a.en.json3'), json3([(1, 2, 'a storm comes'), (4, 2, 'CRACKERS!'), (7, 2, 'storm drain talk')]))
        write(os.path.join(self.yt, 'captions', 'vid-b.en-orig.json3'), json3([(3, 2, '>> one cracker'), (6, 2, 'calm sea')]))
        res = last(run('do-work/count_terms.py', self.ask()))
        self.assertEqual((res['caption_files'], res['terms']), (2, 2))
        rows = {r['term']: r for r in csv.DictReader(open(res['table']), delimiter='\t')}
        self.assertEqual((rows['cracker']['mentions'], rows['cracker']['videos'], rows['cracker']['first_date'],
                          rows['cracker']['last_date']), ('2', '2', '20300105', '20300201'))
        self.assertEqual(rows['cracker']['example_text'], '| one cracker calm sea')
        self.assertEqual((rows['storm']['mentions'], rows['storm']['example_s']), ('1', '1'))    # not the storm drain

    def test_a_rule_the_judge_cannot_compile_is_refused(self):
        write(os.path.join(self.data, 'catalog.tsv'), 'id\tformat\tdate\nvid-a\tepisode\t20300105\n')
        write(os.path.join(self.yt, 'captions', 'vid-a.en.json3'), json3([(1, 2, 'a storm comes')]))
        error = refused(run('do-work/count_terms.py', self.ask(settings={**SETTINGS, 'terms': {'bad': '('}})))
        self.assertIn('the word judge refused the rules', error)

    def test_mentions_are_collected_and_coded(self):
        comments = [{'id': 'c1', 'parent': 'root', 'text': 'The parrot is so funny', 'like_count': 9, 'timestamp': 1},
                    {'id': 'c2', 'parent': 'root', 'text': 'I missed the parrot\tthis week', 'like_count': 3},
                    {'id': 'c3', 'parent': 'root', 'text': 'Nice fog shots', 'like_count': 20},
                    {'id': 'c4', 'parent': 'c1', 'text': 'polly agrees', 'like_count': 1},
                    {'id': 'c5', 'parent': 'root', 'text': 'Polly!', 'like_count': 0}]
        write(os.path.join(self.yt, 'comments', 'vid-a.info.json'), {'id': 'vid-a', 'upload_date': '20300105', 'view_count': 100,
                                                                     'comment_count': 5, 'title': 'Fog', 'comments': comments})
        os.makedirs(self.data)
        res = last(run('do-work/collect_mentions.py', self.ask()))
        self.assertEqual((res['comments_read'], res['mentioning']), (4, 3))
        rows = list(csv.DictReader(open(res['mentions']), delimiter='\t', quoting=csv.QUOTE_NONE))
        self.assertEqual([r['comment_id'] for r in rows], ['c1', 'c2', 'c5'])
        self.assertEqual(rows[1]['text'], 'I missed the parrot / this week')
        summary = list(csv.DictReader(open(os.path.join(self.data, 'comments-summary.tsv')), delimiter='\t'))[0]
        self.assertEqual((summary['mention_share'], summary['mention_like_share'], summary['mentions_in_top20']), ('0.75', '0.375', '3'))
        res = last(run('do-work/code_mentions.py', self.ask()))
        self.assertEqual(res['codes'], {'pleasure': 1, 'absence': 1, 'mention-only': 1})
        coded = [r['codes'] for r in csv.DictReader(open(res['table']), delimiter='\t', quoting=csv.QUOTE_NONE)]
        self.assertEqual(coded, ['pleasure', 'absence', 'mention-only'])


if __name__ == '__main__':
    unittest.main()
