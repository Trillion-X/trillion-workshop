"""Synthetic model-owner/HTTP receipts only: no model, account or original corpus is called."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

FOLDER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cite_principles_command", FOLDER / "do-work/cite_principles.py")
command = importlib.util.module_from_spec(spec)
spec.loader.exec_module(command)

HAS_SCHEMA = importlib.util.find_spec("jsonschema") is not None
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["rows"], "properties": {
    "rows": {"type": "array", "items": {"type": "object", "required": ["part", "statement", "quote"],
                                         "properties": {"part": {"type": "integer"}, "statement": {"type": "string"},
                                                        "quote": {"type": "string"}}}}}}


def reply(content='{"rows": []}', model="actual-model", route="owner-route"):
    return {"model": model, "served_by": route, "choices": [{"finish_reason": "stop", "message": {
        "role": "assistant", "content": content}}], "usage": {"prompt_tokens": 4, "completion_tokens": 3}}


class OwnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        resolver = patch.object(command, "installed_model_cli", return_value="fixture-cli")
        resolver.start(); self.addCleanup(resolver.stop)
        # The shell-owner lookup is a fixture; the site command still resolves by PATH without a shell.
        cli = self.folder / "fixture-cli"
        cli.write_text(f"#!{sys.executable}\n" + '''import json, os, sys, time
data = json.load(sys.stdin)
with open(os.environ['MODEL_TEST_RECEIPT'], 'a') as out:
    out.write(json.dumps({'argv': sys.argv[1:], 'input': data}) + '\\n')
mode = os.environ.get('MODEL_TEST_MODE', 'reply')
if mode == 'exit': sys.exit(7)
if mode == 'not-json': print('not json'); sys.exit(0)
if mode == 'timeout': time.sleep(2)
answer = json.loads(os.environ['MODEL_TEST_REPLY'])
if mode == 'per-request':
    user = data['messages'][1]['content']
    label = 'alpha' if 'alpha' in user else 'beta'
    if label == 'alpha': time.sleep(0.05)
    answer['model'] = label + '-model'
    answer['served_by'] = label + '-route'
print(json.dumps({'exit_code': 0, 'replayed': False, 'tool': 'tool:ask-a-model', 'result': answer}))
''')
        cli.chmod(0o755)
        self.receipt = self.folder / "calls.jsonl"
        self.env = patch.dict(os.environ, {"PATH": str(self.folder) + os.pathsep + os.environ["PATH"],
                             "MODEL_TEST_RECEIPT": str(self.receipt), "MODEL_TEST_MODE": "reply",
                             "MODEL_TEST_REPLY": json.dumps(reply())})
        self.env.start()
        self.addCleanup(self.env.stop)

    def model(self, **more):
        return command.Model({"transport": "workshop", "job": "do-a-task-step", "max_tokens": 2000, **more})

    def test_fixed_cli_stdin_preserves_words_and_returns_per_call_identity(self):
        marker = self.folder / "must-not-exist"
        words = f"$(touch {marker}) `touch {marker}`; 'quoted'\nnew line"
        model = self.model(body={"temperature": 0, "seed": 12})
        content, usage, provenance = model.ask(words, words)
        call = json.loads(self.receipt.read_text())
        self.assertEqual(call['argv'], ['call', 'tool:ask-a-model', '-'])
        self.assertEqual(call['input'], {"job": "do-a-task-step", "messages": [
            {"role": "system", "content": words}, {"role": "user", "content": words}],
            "temperature": 0, "seed": 12, "max_tokens": 2000})
        self.assertFalse(marker.exists())
        self.assertEqual(json.loads(content), {"rows": []})
        self.assertEqual((usage['completion_tokens'], provenance['model'], provenance['served_by']),
                         (3, 'actual-model', 'owner-route'))
        self.assertEqual(provenance['schema_enforcement'], 'none')

    def test_spec_cannot_choose_tool_command_model_or_silently_drop_body_fields(self):
        for extra in ({'tool': 'something'}, {'argv': ['sh']}, {'url': 'http://example.invalid'},
                      {'model': 'pinned'}, {'cli':'other-site'}, {'site_cli':'other-site'}, {'executable':'sh'}, {'body': {'response_format': {}}}, {'max_tokens': 0},
                      {'body': []},
                      {'max_tokens': True}, {'job': ''}, {'transport': 'shell'}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.model(**extra)
        self.assertFalse(self.receipt.exists())

    def test_incomplete_error_tool_only_or_unidentified_receipts_fail_closed(self):
        cases = []
        for reason in ('length', 'tool_calls', 'content_filter', None):
            bad = reply(); bad['choices'][0]['finish_reason'] = reason; cases.append(bad)
        for field, value in [('tool_calls', [{'id': 'x'}]), ('function_call', {'name': 'x'}),
                             ('refusal', 'no'), ('content', None), ('content', ''), ('role', 'tool')]:
            bad = reply(); bad['choices'][0]['message'][field] = value; cases.append(bad)
        for field in ('model', 'served_by'):
            bad = reply(); del bad[field]; cases.append(bad)
        cases += [{'error': {}}, {'isError': True, 'result': reply()}, {'choices': []},
                  reply('{"rows": [{"part": 1}]'), reply('```json\n{"rows": []}\n```'), reply('[]')]
        for bad in cases:
            with self.subTest(bad=bad), patch.dict(os.environ, {'MODEL_TEST_REPLY': json.dumps(bad)}), self.assertRaises(ValueError):
                self.model().ask('system', 'user')

    def test_cli_failure_non_json_and_timeout_do_not_fall_back_to_http(self):
        for mode in ('exit', 'not-json', 'timeout'):
            with self.subTest(mode=mode), patch.dict(os.environ, {'MODEL_TEST_MODE': mode}), \
                    self.assertRaises((ValueError, OSError)):
                model = self.model(); model.timeout = 0.1; model.ask('system', 'user')

    @unittest.skipUnless(HAS_SCHEMA, 'Workshop schema validation requires the documented jsonschema dependency')
    def test_full_original_schema_is_checked_locally_without_sending_unsupported_fields(self):
        original = copy.deepcopy(SCHEMA)
        self.model().ask('system', 'user', SCHEMA)
        call = json.loads(self.receipt.read_text())
        self.assertNotIn('response_format', call['input'])
        self.assertNotIn('reply_schema', call['input'])
        self.assertEqual(SCHEMA, original)
        for content in ('{"rows": [{}]}', '{"rows": [], "extra": 1}', '{"rows": "no"}'):
            with self.subTest(content=content), patch.dict(os.environ, {'MODEL_TEST_REPLY': json.dumps(reply(content))}), \
                    self.assertRaisesRegex(ValueError, 'unchanged extraction reply_schema'):
                self.model().ask('system', 'user', SCHEMA)

    def test_missing_schema_dependency_fails_before_generation(self):
        real_import = __import__
        def no_schema(name, *args, **kwargs):
            if name == 'jsonschema': raise ImportError('stand-in missing dependency')
            return real_import(name, *args, **kwargs)
        with patch('builtins.__import__', side_effect=no_schema), self.assertRaisesRegex(ValueError, 'jsonschema'):
            self.model().ask('system', 'user', SCHEMA)
        self.assertFalse(self.receipt.exists())

    @unittest.skipUnless(HAS_SCHEMA, 'Workshop schema validation requires the documented jsonschema dependency')
    def test_invalid_schema_fails_before_generation(self):
        with self.assertRaisesRegex(ValueError, 'Invalid extraction reply_schema'):
            self.model().ask('system', 'user', {'type': 'not-a-json-schema-type'})
        self.assertFalse(self.receipt.exists())

    def test_shared_threaded_model_has_no_last_identity_race(self):
        model = self.model()
        with patch.dict(os.environ, {'MODEL_TEST_MODE': 'per-request'}), ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda label: model.ask('system', label), ['alpha', 'beta']))
        self.assertEqual([(r[2]['model'], r[2]['served_by']) for r in results],
                         [('alpha-model', 'alpha-route'), ('beta-model', 'beta-route')])
        self.assertNotIn('last_model', vars(model))

    def extract(self, answer, schema=None):
        corpus = self.folder / 'corpus.jsonl'
        corpus.write_text(json.dumps({'id': 'synthetic', 'channel': 'Test', 'title': 'Synthetic', 'words': 8,
                                     'segs': [[0, 'one two three four five six seven eight']], 'duration': 5}) + '\n')
        asks = self.folder / 'asks.json'
        asks.write_text(json.dumps({'name': 'synthetic-only', 'system': 'unchanged system', 'rows_key': 'rows',
                                   'part_field': 'part', 'quote_field': 'quote', 'part_header': '[part {part}]',
                                   **({'reply_schema': schema} if schema is not None else {})}))
        model = self.folder / 'model.json'
        model.write_text(json.dumps({'transport': 'workshop', 'job': 'do-a-task-step', 'max_tokens': 2000}))
        args = argparse.Namespace(asks=str(asks), model=str(model), corpus=str(corpus), out=str(self.folder / 'out'),
            channels=None, videos=None, limit=None, chunk_words=None, max_load=0, wait_for_model=0,
            attempts=1, retry_seconds=0, concurrency=2, report_every=100, coverage_out=None)
        with patch.dict(os.environ, {'MODEL_TEST_REPLY': json.dumps(answer)}):
            result = command.command_extract(args)
        done = [json.loads(line) for line in (self.folder / 'out/done.jsonl').read_text().splitlines()]
        return args, result, done

    def test_truncated_reply_cannot_checkpoint_video_complete_and_retry_remains_possible(self):
        bad = reply('{"rows": []}'); bad['choices'][0]['finish_reason'] = 'length'
        args, result, done = self.extract(bad)
        self.assertEqual((result['failed_parts'], done[-1]['failed_parts'], done[-1]['rows']), (1, 1, 0))
        with patch.dict(os.environ, {'MODEL_TEST_REPLY': json.dumps(reply())}):
            retry = command.command_extract(args)
        self.assertEqual((retry['videos'], retry['failed_parts']), (1, 0))
        with patch.dict(os.environ, {'MODEL_TEST_MODE': 'exit'}):
            skipped = command.command_extract(args)
        self.assertEqual(skipped['videos'], 0, 'already completed calls are not replayed')

    def test_schema_free_wrong_container_cannot_finish_and_actual_provenance_is_written(self):
        _, _, done = self.extract(reply('{}'))
        self.assertEqual(done[-1]['failed_parts'], 1)
        content = json.dumps({'rows': [{'part': 1, 'statement': 'Synthetic idea',
                                       'quote': 'one two three four five six seven eight'}]})
        _, _, done = self.extract(reply(content))
        rows = [json.loads(line) for line in (self.folder / 'out/Test.jsonl').read_text().splitlines()]
        self.assertEqual(rows[0]['id'], 'synthetic@0#1')
        self.assertEqual(rows[0]['extracted_by'], 'actual-model')
        self.assertEqual(rows[0]['extraction_model']['served_by'], 'owner-route')
        self.assertEqual(done[-1]['model_replies'][0]['model'], 'actual-model')

    @unittest.skipUnless(HAS_SCHEMA, 'Workshop schema validation requires the documented jsonschema dependency')
    def test_schema_invalid_complete_reply_cannot_checkpoint_video_complete(self):
        _, result, done = self.extract(reply('{"rows": [{}]}'), SCHEMA)
        self.assertEqual((result['failed_parts'], done[-1]['failed_parts'], done[-1]['rows']), (1, 1, 0))


class HttpTest(unittest.TestCase):
    def test_existing_request_shape_is_preserved_and_length_finish_is_refused(self):
        captured = []
        answer = reply(model='actual-http', route='http-route')
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                captured.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                data = json.dumps(answer).encode(); self.send_response(200); self.end_headers(); self.wfile.write(data)
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            model = command.Model({'url': f'http://127.0.0.1:{server.server_port}/v1', 'model': 'requested',
                                   'max_tokens': 2500, 'body': {'seed': 42, 'temperature': 0.2}})
            _, _, provenance = model.ask('system', 'user', SCHEMA)
            self.assertEqual(captured[0], {'model': 'requested', 'max_tokens': 2500, 'seed': 42, 'temperature': 0.2,
                'messages': [{'role': 'system', 'content': 'system'}, {'role': 'user', 'content': 'user'}],
                'response_format': {'type': 'json_schema', 'json_schema': {'name': 'rows', 'strict': True, 'schema': SCHEMA}}})
            self.assertEqual(provenance['model'], 'actual-http')
            answer['choices'][0]['finish_reason'] = 'length'
            with self.assertRaises(ValueError): model.ask('system', 'user', SCHEMA)
        finally:
            server.shutdown(); server.server_close(); thread.join()


class CliResolutionTest(unittest.TestCase):
    def test_installed_site_owner_supplies_the_command_without_caller_override(self):
        for name in ('site-a','site-b'):
            value=argparse.Namespace(returncode=0,stdout=json.dumps({'cli':name}).encode(),stderr=b'')
            with patch.object(command.subprocess,'run',return_value=value) as called:
                self.assertEqual(command.installed_model_cli(),name)
            argv=called.call_args.args[0]
            self.assertEqual(argv[:3],['node','--input-type=module','--eval'])
            self.assertIn('owner.installedSiteCommand()',argv[3])
            self.assertTrue(argv[4].endswith('/use-your-tools-from-a-shell/read-data/installed-site.mjs'))
            self.assertFalse(called.call_args.kwargs.get('shell',False))

    def test_missing_ambiguous_or_invalid_site_resolution_refuses_without_fallback(self):
        cases=[b'null',b'{"cli":null}',b'{"cli":"site-a","other":1}',b'{"cli":"a","cli":"b"}',
               b'{"cli":"sh -c"}',b'{"cli":"/bin/sh"}',b'{"cli":"--flag"}',b'{"cli":[]}']
        for raw in cases:
            with patch.object(command.subprocess,'run',return_value=argparse.Namespace(returncode=0,stdout=raw,stderr=b'')),self.assertRaises(ValueError):command.installed_model_cli()
        with patch.object(command.subprocess,'run',return_value=argparse.Namespace(returncode=1,stdout=b'',stderr=b'private detail')),self.assertRaisesRegex(ValueError,'Exactly one installed site'):
            command.installed_model_cli()
        with patch.object(command.subprocess,'run',side_effect=command.subprocess.TimeoutExpired(['node'],30)),self.assertRaisesRegex(ValueError,'Cannot resolve'):
            command.installed_model_cli()

    def test_site_command_is_cached_and_bound_without_mutating_profile(self):
        profile={'transport':'workshop','job':'do-a-task-step','max_tokens':2000}
        model=command.Model(profile)
        with patch.object(command,'installed_model_cli',side_effect=['site-a','site-b']) as resolver:
            first=model.binding_profile();second=model.binding_profile()
        self.assertEqual(resolver.call_count,1);self.assertEqual(first,second)
        self.assertEqual(first['site_cli'],'site-a');self.assertNotIn('site_cli',profile)
        self.assertNotIn('site_cli',model.spec)


if __name__ == '__main__':
    unittest.main()
