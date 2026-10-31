"""Stdlib tests for the batch sender, against a made-up list service (test/fixtures/fake_list_service.py)."""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
FAKE = Path(__file__).resolve().parent / 'fixtures' / 'fake_list_service.py'
sys.path.insert(0, str(TOOL / 'read-data'))
sys.path.insert(0, str(TOOL / 'do-work'))
import send_batches  # noqa: E402
import send_list_rows as cli  # noqa: E402


class Sender(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='send-batches-test-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.batches = self.tmp / 'batches'
        self.batches.mkdir()
        self.service = self.tmp / 'service.json'
        os.environ['FAKE_SERVICE'] = str(self.service)
        self.addCleanup(os.environ.pop, 'FAKE_SERVICE', None)
        self.set_service()
        files = []
        for family, list_id, counts in (('fruit', 'fruit-list', [4, 2]), ('veg', 'veg-list', [3])):
            for n, count in enumerate(counts):
                name = f'{family}-{n:03d}.json'
                rows = [{'id': f'{family}-{n}-{i}', 'values': {}} for i in range(count)]
                (self.batches / name).write_text(json.dumps({'list_id': list_id, 'rows': rows}))
                files.append({'file': name, 'list_id': list_id, 'rows': count})
        (self.batches / 'manifest.json').write_text(json.dumps({'batches': files}))
        self.status = self.tmp / 'status.json'
        self.config = {'send': {'argv': [sys.executable, str(FAKE), 'put'], 'input': {'list_id': '$list_id', 'rows': '$rows'}, 'kept_count': 'kept'},
                       'warm': {'argv': [sys.executable, str(FAKE), 'warm'], 'input': {'list_id': '$list_id'}},
                       'retry_if': ['catching up'], 'halve_if': ['memory limit'], 'waits': [0, 0, 0]}

    def set_service(self, **plan):
        self.service.write_text(json.dumps({'calls': [], **plan}))

    def calls(self):
        return json.loads(self.service.read_text())['calls']

    def test_every_batch_is_sent_in_manifest_order_after_a_warm_up_and_progress_is_kept(self):
        status = send_batches.run(self.config, self.batches, self.status)
        self.assertEqual(status['state'], 'all_batches_sent')
        self.assertEqual(status['batches_done'], {'fruit-000.json': 4, 'fruit-001.json': 2, 'veg-000.json': 3})
        self.assertEqual([(c['mode'], c['list_id']) for c in self.calls()][:4], [('warm', 'fruit-list'), ('put', 'fruit-list'), ('warm', 'fruit-list'), ('put', 'fruit-list')])
        self.assertEqual(json.loads(self.status.read_text()), status)

    def test_a_rerun_sends_only_what_is_not_recorded_as_done(self):
        send_batches.run(self.config, self.batches, self.status, only=['fruit'])
        self.set_service()
        status = send_batches.run(self.config, self.batches, self.status)
        self.assertEqual([c['list_id'] for c in self.calls() if c['mode'] == 'put'], ['veg-list'])
        self.assertEqual(sorted(status['batches_done']), ['fruit-000.json', 'fruit-001.json', 'veg-000.json'])

    def test_order_in_the_config_wins_over_the_manifest(self):
        send_batches.run({**self.config, 'order': ['veg', 'fruit']}, self.batches, self.status)
        self.assertEqual([c['list_id'] for c in self.calls() if c['mode'] == 'put'][0], 'veg-list')

    def test_a_busy_answer_is_retried_after_a_wait_and_the_waits_are_taken(self):
        self.set_service(busy_first=2)
        waited = []
        status = send_batches.run(self.config, self.batches, self.status, wait=waited.append)
        self.assertEqual(status['state'], 'all_batches_sent')
        self.assertEqual(sum(1 for c in self.calls() if c['mode'] == 'put'), 3 + 2)
        self.assertEqual(waited[:3], [0, 0, 0])

    def test_a_batch_that_is_too_big_is_sent_as_halves(self):
        self.set_service(max_rows=2)
        status = send_batches.run(self.config, self.batches, self.status)
        self.assertEqual(status['batches_done']['fruit-000.json'], 4)
        self.assertIn(4, [c['rows'] for c in self.calls()])
        self.assertEqual(sorted(c['rows'] for c in self.calls() if c['mode'] == 'put' and c['list_id'] == 'fruit-list')[:3], [2, 2, 2])

    def test_a_refusal_stops_the_run_and_the_status_says_which_batch_and_why(self):
        self.set_service(refuse_list='veg-list')
        status = send_batches.run(self.config, self.batches, self.status)
        self.assertEqual(status['state'], 'stopped_on_refusal')
        self.assertEqual(status['last_refusal'], {'batch': 'veg-000.json', 'sent': 3, 'kept': -1, 'error': 'these records are refused\n'})
        self.assertEqual(sorted(status['batches_done']), ['fruit-000.json', 'fruit-001.json'])
        self.set_service()
        self.assertEqual(send_batches.run(self.config, self.batches, self.status)['state'], 'all_batches_sent')
        self.assertNotIn('last_refusal', json.loads(self.status.read_text()))

    def test_retries_run_out_and_the_batch_is_refused(self):
        self.set_service(busy_first=99)
        status = send_batches.run(self.config, self.batches, self.status)
        self.assertEqual(status['state'], 'stopped_on_refusal')
        self.assertEqual(status['last_refusal']['batch'], 'fruit-000.json')

    def test_the_command_reads_a_config_inside_a_larger_file_and_exits_by_outcome(self):
        config = self.tmp / 'mapping.json'
        config.write_text(json.dumps({'new_lists': [], 'sending': self.config}))
        argv = ['--config', str(config), '--key', 'sending', '--batches', str(self.batches), '--status', str(self.status)]
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(cli.main(argv), 0)
            self.set_service(refuse_list='fruit-list')
            self.status.unlink()
            self.assertEqual(cli.main(argv), 1)
            self.assertEqual(cli.main([*argv[:-2], '--status', str(self.status), '--key', 'missing']), 2)
        self.assertIn("'missing'", err.getvalue())


if __name__ == '__main__':
    unittest.main()
