"""Runs find_outliers.py on made-up channels and videos written here."""
import csv, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'do-work', 'find_outliers.py')
sys.path.insert(0, os.path.join(HERE, '..', 'do-work'))
import find_outliers  # noqa: E402

HEADER = ['source', 'kind', 'added', 'url', 'views', 'length', 'channel', 'title']


def row(source, views, title, n, kind='video', channel=None):
    return [source, kind, '2026-01-01', f'https://example.com/{source}/{n}', str(views), '60', channel or source.title(), title]


# Glimmerhatch: median 2,000; one video at 50,000 (25x) and one at 9,000 (4.5x, under 5x).
# Quillborough: median 3,000 (2,000 2,000 3,000 4,000 900,000); 900,000 is 300x; 12,000 would be 4x.
# Tinsel Moor: one tiny video at 6,000 views, 6x its source median of 1,000 but under 10,000 views.
ROWS = [
    row('glimmerhatch', 2000, 'Ordinary sprocket', 1), row('glimmerhatch', 2000, 'Another sprocket', 2),
    row('glimmerhatch', 50000, 'The sprocket that flew', 3), row('glimmerhatch', 9000, 'A good sprocket', 4),
    row('glimmerhatch', 1000, 'Quiet sprocket', 5),
    row('quillborough', 2000, 'Fen walk one', 1), row('quillborough', 2000, 'Fen walk two', 2),
    row('quillborough', 3000, 'Fen walk three', 3), row('quillborough', 4000, 'Fen walk four', 4),
    row('quillborough', 900000, 'The fen at night', 5, kind='short'),
    row('tinsel-moor', 1000, 'Small one', 1), row('tinsel-moor', 1000, 'Small two', 2), row('tinsel-moor', 6000, 'Small three', 3),
    # Not counted: no title, views not a number, a short line.
    row('glimmerhatch', 999999, '', 6), row('glimmerhatch', 'n/a', 'Missing views', 7), ['glimmerhatch', 'video'],
]


class FindOutliers(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.src = os.path.join(self.dir, 'videos.tsv')
        self.write(self.src, HEADER, ROWS)

    def write(self, path, header, rows):
        with open(path, 'w', newline='') as f:
            w = csv.writer(f, delimiter='\t')
            w.writerow(header)
            w.writerows(rows)

    def run_it(self, *args, src=None):
        out = os.path.join(self.dir, 'outliers.tsv')
        done = subprocess.run([sys.executable, '-I', SCRIPT, src or self.src, out, *args], capture_output=True, text=True)
        last = json.loads(done.stdout.strip().splitlines()[-1])
        rows = list(csv.reader(open(out), delimiter='\t')) if os.path.exists(out) and done.returncode == 0 else []
        return done, last, rows

    def test_only_rows_five_times_their_source_median_and_ten_thousand_views(self):
        done, last, rows = self.run_it()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(rows[0], ['ratio', 'views', 'kind', 'channel', 'source', 'median', 'n', 'url', 'title'])
        self.assertEqual(rows[1:], [
            ['25.0', '50000', 'video', 'Glimmerhatch', 'glimmerhatch', '2000', '5', 'https://example.com/glimmerhatch/3', 'The sprocket that flew'],
            ['300.0', '900000', 'short', 'Quillborough', 'quillborough', '3000', '5', 'https://example.com/quillborough/5', 'The fen at night'],
        ])
        self.assertEqual(last['result']['rows_read'], 13)
        self.assertEqual(last['result']['found'], 2)
        self.assertEqual(last['result']['sources'], 2)

    def test_thresholds_are_arguments(self):
        _, last, rows = self.run_it('--min-ratio', '4', '--min-views', '5000')
        titles = [r[8] for r in rows[1:]]
        self.assertEqual(titles, ['The sprocket that flew', 'A good sprocket', 'The fen at night', 'Small three'])
        self.assertEqual(last['result']['min_ratio'], 4.0)

    def test_columns_by_name_in_another_order(self):
        header = ['title', 'views', 'channel', 'url', 'kind', 'source']
        src = os.path.join(self.dir, 'reordered.tsv')
        self.write(src, header, [[r[7], r[4], r[6], r[3], r[1], r[0]] for r in ROWS if len(r) == 8])
        _, last, rows = self.run_it('--title-col', 'title', '--views-col', 'views', '--channel-col', 'channel',
                                    '--url-col', 'url', '--kind-col', 'kind', '--source-col', '5', src=src)
        self.assertEqual([r[8] for r in rows[1:]], ['The sprocket that flew', 'The fen at night'])
        self.assertEqual(last['result']['found'], 2)

    def test_refusals_say_what_to_change(self):
        for args, src, message in [
            ([], os.path.join(self.dir, 'absent.tsv'), 'is not there'),
            (['--title-col', 'headline'], None, 'neither a column number nor a header name'),
            (['--min-ratio', '0'], None, 'above 0'),
        ]:
            done, last, _ = self.run_it(*args, src=src)
            self.assertEqual(done.returncode, 2)
            self.assertIn(message, last['error'])
        empty = os.path.join(self.dir, 'empty.tsv')
        open(empty, 'w').close()
        done, last, _ = self.run_it(src=empty)
        self.assertIn('is empty', last['error'])

    def test_a_source_with_a_zero_median_has_no_outliers(self):
        found, read = find_outliers.outliers([['nil', 'video', '', 'u1', '0', '', 'Nil', 'a'], ['nil', 'video', '', 'u2', '0', '', 'Nil', 'b'],
                                              ['nil', 'video', '', 'u3', '50000', '', 'Nil', 'c']], find_outliers.COLUMNS)
        self.assertEqual((found, read), ([], 3))


if __name__ == '__main__':
    unittest.main()
