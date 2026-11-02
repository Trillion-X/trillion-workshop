"""Runs series_parts.py on made-up clips written here."""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'do-work', 'series_parts.py')


def moment(clip, n, text, **extra):
    row = {'id': f'{clip}#{n}', 'identity': f'ident-{clip}', 'name': f'{clip}.mov', 'path': f'/clips/{clip}.mov', 'source': 'cam-a', 'text': text}
    row.update(extra)
    return row


# Moments arrive out of order; the clip's text is joined by moment number.
FIRST = [
    moment('zeb', 2, 'and that is how the lantern got its glow.'),
    moment('zeb', 1, 'Okay this is part three of the lantern saga'),
    moment('alder', 1, 'Part 12. We open the copper box today.'),
    moment('mire', 1, 'Nothing about series here, just a walk by the pond.'),
    # Named late: "part two" sits after the first 300 characters.
    moment('fennel', 1, 'x ' * 160 + 'part two'),
    # "partly" and "parts" are not "part <n>"; "department 4" is not either.
    moment('quell', 1, 'It is partly cloudy, the parts 5 arrived, the department 4 called.'),
]
# A second file adds a moment to an existing clip, and a clip that has only source_file and no identity or path.
SECOND = [
    moment('alder', 2, 'Then we close it.'),
    {'id': 'loose#1', 'name': '', 'source_file': '/other/loose.mp4', 'text': 'PART ONE: the beginning', 'identity': 'ident-loose'},
]


class SeriesParts(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.a = self.write('a.jsonl', FIRST)
        self.b = self.write('b.jsonl', SECOND)

    def write(self, name, rows, raw=None):
        path = os.path.join(self.dir, name)
        with open(path, 'w') as f:
            f.write(raw if raw is not None else ''.join(json.dumps(r) + '\n' for r in rows))
        return path

    def run_it(self, *args):
        done = subprocess.run([sys.executable, '-I', SCRIPT, *args], capture_output=True, text=True)
        lines = done.stdout.strip().splitlines()
        return done, [l.split('\t') for l in lines[:-1]], json.loads(lines[-1])

    def test_clips_that_name_their_part_early_ordered_by_path(self):
        done, rows, last = self.run_it(self.a, self.b)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([r[:4] for r in rows], [
            ['alder.mov', '/clips/alder.mov', 'cam-a', 'part 12'],
            ['zeb.mov', '/clips/zeb.mov', 'cam-a', 'part three'],
            ['loose.mp4', '/other/loose.mp4', '', 'part ONE'],
        ])
        self.assertEqual(rows[0][4], 'Part 12. We open the copper box today. Then we close it.')
        self.assertEqual(rows[1][4], 'Okay this is part three of the lantern saga and that is how the lantern got its glow.')
        self.assertEqual(last['result'], {'clips': 6, 'series_parts': 3, 'within': 300, 'out': None})

    def test_within_is_an_argument(self):
        _, rows, last = self.run_it(self.a, '--within', '400')
        self.assertIn('fennel.mov', [r[0] for r in rows])
        _, rows, _ = self.run_it(self.a, '--within', '10')
        self.assertEqual([r[0] for r in rows], ['alder.mov'])

    def test_out_writes_the_lines_and_prints_only_the_summary(self):
        out = os.path.join(self.dir, 'parts.tsv')
        done = subprocess.run([sys.executable, '-I', SCRIPT, self.a, '--out', out], capture_output=True, text=True)
        self.assertEqual(len(done.stdout.strip().splitlines()), 1)
        self.assertEqual(json.loads(done.stdout)['result']['series_parts'], 2)
        self.assertEqual([l.split('\t')[0] for l in open(out).read().splitlines()], ['alder.mov', 'zeb.mov'])

    def test_refusals_say_what_to_change(self):
        bad = self.write('bad.jsonl', None, raw='{"text": "no id"}\n')
        notjson = self.write('notjson.jsonl', None, raw='hello\n')
        for args, message in [([os.path.join(self.dir, 'absent.jsonl')], 'is not there'), ([bad], 'line 1 is not a moment row'),
                              ([notjson], 'is not a moment row'), ([self.a, '--within', '0'], '1 or more')]:
            done, _, last = self.run_it(*args)
            self.assertEqual(done.returncode, 2)
            self.assertIn(message, last['error'])


if __name__ == '__main__':
    unittest.main()
