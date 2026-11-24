"""Hostile reply, retry, source-identity and phase controls. No real model/network calls."""
import argparse
import copy
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

FOLDER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("safe_command", FOLDER / "do-work/cite_principles.py")
command = importlib.util.module_from_spec(spec)
spec.loader.exec_module(command)


def receipt(content='{"rows": []}', route="route-a"):
    return {"exit_code": 0, "tool": "tool:ask-a-model", "replayed": False, "result": {
        "model": "reported", "served_by": route, "choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": content}}], "usage": {"prompt_tokens": 4, "completion_tokens": 3}}}


class AdmissionTest(unittest.TestCase):
    def setUp(self):
        resolver = patch.object(command, "installed_model_cli", return_value="fixture-cli")
        resolver.start(); self.addCleanup(resolver.stop)

    def ask(self, raw, schema=None):
        completed = SimpleNamespace(returncode=0, stdout=raw, stderr="")
        with patch.object(command.subprocess, "run", return_value=completed):
            return command.Model({"transport": "workshop", "job": "do-a-task-step", "max_tokens": 2000}).ask("s", "u", schema)

    def test_raw_duplicate_members_and_nonfinite_constants_are_refused(self):
        good = json.dumps(receipt())
        raws = [good.replace('"exit_code": 0', '"exit_code": 1, "exit_code": 0'),
                good.replace('"replayed": false', '"replayed": true, "replayed": false'),
                json.dumps(receipt('{"rows": [], "rows": []}')),
                json.dumps(receipt('{"rows": [], "number": NaN}')),
                json.dumps(receipt('{"rows": [], "number": Infinity}'))]
        for raw in raws:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.ask(raw)

    def test_rejected_reply_keeps_claimed_identity_status_and_finish(self):
        value = receipt(); value['result']['choices'][0]['finish_reason'] = 'length'
        with self.assertRaises(ValueError) as raised:
            self.ask(json.dumps(value))
        evidence = raised.exception.evidence
        self.assertEqual((evidence['model'], evidence['served_by'], evidence['finish_reason']), ('reported', 'route-a', 'length'))
        self.assertEqual(evidence['owner_receipt'], {'exit_code': 0, 'tool': 'tool:ask-a-model', 'replayed': False})

    def test_unavailable_or_remote_reference_refused_before_dispatch(self):
        for schema in ({'$ref': '#/$defs/absent'}, {'$ref': 'https://example.invalid/schema'},
                       {'$schema': 'https://example.invalid/dialect', 'type': 'object'}):
            with self.subTest(schema=schema), patch.object(command.subprocess, 'run') as run, \
                    patch.object(command.urllib.request, 'urlopen') as http, self.assertRaises(ValueError):
                command.Model({'transport': 'workshop', 'job': 'do-a-task-step', 'max_tokens': 2000}).ask('s', 'u', schema)
            run.assert_not_called(); http.assert_not_called()

    def test_local_reference_works_and_validated_value_is_returned(self):
        schema = {'$defs': {'rows': {'type': 'array'}}, 'type': 'object', 'required': ['rows'],
                  'properties': {'rows': {'$ref': '#/$defs/rows'}}}
        answer = self.ask(json.dumps(receipt()), schema)
        self.assertEqual(answer.value, {'rows': []})

    def test_chained_reference_is_preflighted_and_cycles_do_not_loop(self):
        chained = {'$ref': '#/default', 'default': {'$ref': '#/absent'}}
        with patch.object(command.subprocess, 'run') as run, self.assertRaises(ValueError):
            self.ask(json.dumps(receipt()), chained)
        run.assert_not_called()
        schema = {'type': 'object', '$defs': {'node': {'type': 'object', 'properties': {'next': {'$ref': '#/$defs/node'}}}},
                  'properties': {'rows': {'type': 'array'}}}
        self.assertEqual(self.ask(json.dumps(receipt()), schema).value, {'rows': []})

    def test_unknown_embedded_schema_dialects_refuse_before_dispatch(self):
        foreign = {'$schema':'https://example.invalid/unknown-dialect', '$id':'urn:local:foreign', 'type':'object'}
        cases = [{'$schema':'https://json-schema.org/draft/2020-12/schema', '$defs':{'foreign':foreign}, '$ref':'urn:local:foreign'},
                 {'properties':{'rows':{'$schema':'https://example.invalid/unknown-dialect','type':'array'}}},
                 {'$ref':'#/default','default':foreign}]
        for schema in cases:
            with patch.object(command.subprocess, 'run', return_value=SimpleNamespace(returncode=0,stdout=json.dumps(receipt()),stderr='')) as call, self.assertRaises(ValueError):
                command.Model({'transport':'workshop','job':'do-a-task-step','max_tokens':2000}).ask('s','u',schema)
            call.assert_not_called()

    def test_cross_dialect_fragment_needs_explicit_runtime_dialect(self):
        target = {'type':'object','dependencies':{'flag':['required_by_draft7']}}
        schema = {'$schema':'https://json-schema.org/draft/2020-12/schema','$ref':'urn:embedded#/definitions/result',
                  '$defs':{'embedded':{'$id':'urn:embedded','$schema':'http://json-schema.org/draft-07/schema#','definitions':{'result':target}}}}
        bad = json.dumps(receipt('{"rows":[],"flag":true}'))
        with self.assertRaises(ValueError): self.ask(bad,schema)
        target['$schema']='http://json-schema.org/draft-07/schema#'
        with self.assertRaises(ValueError): self.ask(bad,schema)
        answer=self.ask(json.dumps(receipt('{"rows":[],"flag":true,"required_by_draft7":true}')),schema)
        self.assertTrue(answer.value['required_by_draft7'])

    def test_representation_rejects_preserve_only_safe_unique_diagnostic_claims(self):
        for transport in ('workshop','http'):
            value=receipt();value['result']['provider_note']='\ud800';value['result']['choices'][0]['finish_reason']='length'
            raw=json.dumps(value if transport=='workshop' else value['result'])
            model=command.Model({'transport':'workshop','job':'do-a-task-step','max_tokens':2000}) if transport=='workshop' else command.Model({'url':'http://example.invalid/v1','model':'requested'})
            with patch.object(command.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=raw,stderr='')), \
                    patch.object(command.urllib.request,'urlopen',return_value=io.BytesIO(raw.encode())),self.assertRaises(ValueError) as raised:
                model.ask('s','u')
            evidence=raised.exception.evidence
            self.assertEqual((evidence['model'],evidence['served_by'],evidence['finish_reason']),('reported','route-a','length'))
            if transport=='workshop':self.assertEqual(evidence['owner_receipt'],{'exit_code':0,'tool':'tool:ask-a-model','replayed':False})
        # Duplicate syntax yields no reconstructed claims; unsafe identity text is omitted.
        self.assertEqual(command.mr.diagnostic_claims('{"model":"a","model":"b"}'),{})
        self.assertEqual(command.mr.diagnostic_claims('{"model":1e999,"usage":NaN,"served_by":"safe"}'),{'served_by':'safe'})
        self.assertNotIn('model',command.mr.diagnostic_claims('{"model":"\\ud800","served_by":"safe"}'))

    def test_no_id_dialect_pointer_is_refused_before_dispatch(self):
        target={'type':'object','dependencies':{'flag':['required_by_draft7']}}
        schema={'$schema':'https://json-schema.org/draft/2020-12/schema', '$ref':'#/$defs/embedded/definitions/result',
                '$defs':{'embedded':{'$schema':'http://json-schema.org/draft-07/schema#','definitions':{'result':target}}}}
        with patch.object(command.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(receipt('{"rows":[],"flag":true}')),stderr='')) as cli,self.assertRaises(ValueError):
            command.Model({'transport':'workshop','job':'do-a-task-step','max_tokens':2000}).ask('s','u',schema)
        cli.assert_not_called()
        target['$schema']='http://json-schema.org/draft-07/schema#'
        with self.assertRaises(ValueError):self.ask(json.dumps(receipt('{"rows":[],"flag":true}')),schema)
        self.assertTrue(self.ask(json.dumps(receipt('{"rows":[],"flag":true,"required_by_draft7":true}')),schema).value['required_by_draft7'])

    def test_reference_discovered_dialect_boundaries_refuse_in_both_orders(self):
        target={'type':'object','dependencies':{'flag':['required_by_draft7']}}
        refs=[{'$ref':'#/default'},{'$ref':'#/default/definitions/result'}]
        for order in (refs,list(reversed(refs))):
            schema={'$schema':'https://json-schema.org/draft/2020-12/schema','allOf':order,
                    'default':{'$schema':'http://json-schema.org/draft-07/schema#','definitions':{'result':target}}}
            with patch.object(command.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(receipt('{"rows":[],"flag":true}')),stderr='')) as cli,self.assertRaises(ValueError):
                command.Model({'transport':'workshop','job':'do-a-task-step','max_tokens':2000}).ask('s','u',schema)
            cli.assert_not_called()
            explicit=copy.deepcopy(schema);explicit['default']['definitions']['result']['$schema']='http://json-schema.org/draft-07/schema#'
            with self.assertRaises(ValueError):self.ask(json.dumps(receipt('{"rows":[],"flag":true}')),explicit)
            self.assertTrue(self.ask(json.dumps(receipt('{"rows":[],"flag":true,"required_by_draft7":true}')),explicit).value['required_by_draft7'])

    def test_reference_discovered_same_dialect_schemas_work_in_both_orders(self):
        refs=[{'$schema':'http://json-schema.org/draft-07/schema#','$ref':'#/default/definitions/result'},
              {'$schema':'http://json-schema.org/draft-07/schema#','$ref':'#/default'}]
        for order in (refs,list(reversed(refs))):
            schema={'$schema':'https://json-schema.org/draft/2020-12/schema','allOf':order,
                    'default':{'$schema':'http://json-schema.org/draft-07/schema#','definitions':{'result':{'type':'object'}}}}
            self.assertEqual(self.ask(json.dumps(receipt()),schema).value,{'rows':[]})

    def test_strict_decoded_reply_diagnostics_share_the_reply_field_policy(self):
        for transport in ('workshop','http'):
            value=receipt();value['result']['choices'][0]['finish_reason']='length'
            value['result'].update(tool={'wrong':'shape'},exit_code=900,replayed=True)
            raw=json.dumps(value if transport=='workshop' else value['result'])
            model=command.Model({'transport':'workshop','job':'do-a-task-step','max_tokens':2000}) if transport=='workshop' else command.Model({'url':'http://example.invalid/v1','model':'requested'})
            with patch.object(command.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=raw,stderr='')), \
                    patch.object(command.urllib.request,'urlopen',return_value=io.BytesIO(raw.encode())),self.assertRaises(ValueError) as raised:
                model.ask('s','u')
            evidence=raised.exception.evidence
            for field in ('tool_type','exit_code','exit_code_type','replayed','replayed_type'):
                self.assertNotIn(field,evidence)
            if transport=='workshop':self.assertEqual(evidence['tool'],'tool:ask-a-model')
            else:self.assertNotIn('tool',evidence)
            self.assertEqual((evidence['model'],evidence['finish_reason']),('reported','length'))

    def test_provisional_only_schema_children_do_not_poison_discovery(self):
        refs=[{'$schema':'http://json-schema.org/draft-07/schema#','$ref':'#/default/definitions/result'},
              {'$schema':'http://json-schema.org/draft-07/schema#','$ref':'#/default'}]
        for child in ({'$schema':'https://example.invalid/unknown-dialect'},
                      {'$schema':'https://json-schema.org/draft/2020-12/schema','$ref':'https://example.invalid/missing'}):
            for order in (refs,list(reversed(refs))):
                schema={'$schema':'https://json-schema.org/draft/2020-12/schema','allOf':order,
                        'default':{'$schema':'http://json-schema.org/draft-07/schema#','definitions':{'result':{'type':'object','prefixItems':[child]}}}}
                self.assertEqual(self.ask(json.dumps(receipt()),schema).value,{'rows':[]})

    def test_recovery_retains_representable_numeric_type_claims(self):
        for transport in ('workshop','http'):
            value=receipt();value['result'].update(model=0.5,usage=0.5);value['result']['choices'][0]['finish_reason']='length'
            for rejected_unicode in (False,True):
                if rejected_unicode:value['result']['provider_note']='\ud800'
                raw=json.dumps(value if transport=='workshop' else value['result'])
                model=command.Model({'transport':'workshop','job':'do-a-task-step','max_tokens':2000}) if transport=='workshop' else command.Model({'url':'http://example.invalid/v1','model':'requested'})
                with patch.object(command.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=raw,stderr='')), \
                        patch.object(command.urllib.request,'urlopen',return_value=io.BytesIO(raw.encode())),self.assertRaises(ValueError) as raised:
                    model.ask('s','u')
                self.assertEqual((raised.exception.evidence['model_type'],raised.exception.evidence['usage_type']),('float','float'))

    def test_http_boundaries_use_only_json_whitespace(self):
        model=command.Model({'url':'http://example.invalid/v1','model':'requested'})
        schema={'type':'object','required':['rows'],'properties':{'rows':{'type':'array'}}}
        def ask(content):
            value=receipt(content)['result']
            with patch.object(command.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(value).encode())):
                return model.ask('s','u',schema)
        for whitespace in ('\u00a0','\u000c','\u000b','\u0085'):
            for content in (whitespace+'{"rows":[]}', '{"rows":[]}'+whitespace, '```'+whitespace+'json\n{"rows":[]}\n```'):
                with self.assertRaises(ValueError):ask(content)
        self.assertEqual(ask(' \t\r\n{"rows":[]}\r\n\t ').value,{'rows':[]})
        self.assertEqual(ask('\t<think>frame</think>\n```json\n{"rows":[]}\n```\r\n').value,{'rows':[]})
        self.assertEqual(ask('{"rows":[],"label":"\u00a0"}').value['label'],'\u00a0')

    def test_malformed_usage_and_model_metadata_refused_by_both_transports(self):
        for transport in ('http', 'workshop'):
            model = command.Model({'url': 'http://example.invalid/v1', 'model': 'requested'}) if transport == 'http' else \
                command.Model({'transport': 'workshop', 'job': 'do-a-task-step', 'max_tokens': 2000})
            for field, bad in [('usage', 'wrong'), ('usage', {'prompt_tokens': None}),
                               ('usage', {'completion_tokens': True}), ('usage', {'total_tokens': -1}),
                               ('model', {'id': 'wrong'}), ('model', ['wrong'])]:
                value = copy.deepcopy(receipt()['result']); value[field] = bad
                with self.subTest(transport=transport, field=field, bad=bad), self.assertRaises(ValueError):
                    model.completed_reply(value)

    def test_http_native_schema_request_is_not_assumed_enforced(self):
        schema = {'type': 'object', 'properties': {'rows': {'type': 'array', 'minItems': 1}}, 'required': ['rows']}
        with patch.object(command.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(receipt()['result']).encode())), \
                self.assertRaises(ValueError):
            command.Model({'url': 'http://example.invalid/v1', 'model': 'requested'}).ask('s', 'u', schema)

    def test_http_fallback_uses_effective_request_model(self):
        value = receipt()['result']; del value['model']
        with patch.object(command.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(value).encode())) as run:
            answer = command.Model({'url': 'http://example.invalid/v1', 'model': 'old', 'body': {'model': 'effective'}}).ask('s', 'u')
        self.assertEqual(json.loads(run.call_args.args[0].data)['model'], 'effective')
        self.assertEqual((answer[2]['model'], answer[2]['requested_model'], answer[2]['model_reported']), ('effective', 'effective', False))

    def test_configured_http_schema_validates_framed_value(self):
        schema = {'type': 'object', 'required': ['rows'], 'properties': {'rows': {'type': 'array'}}}
        model = command.Model({'url': 'http://example.invalid/v1', 'model': 'requested'})
        for content, accepted in [('<think>private reasoning</think>```json\n{"rows": []}\n```', True),
                                  ('```json\n{"rows": "bad"}\n```', False)]:
            value = receipt(content)['result']
            with self.subTest(content=content), patch.object(command.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(value).encode())):
                if accepted:
                    self.assertEqual(model.ask('s', 'u', schema).value, {'rows': []})
                else:
                    with self.assertRaises(ValueError): model.ask('s', 'u', schema)

    def test_http_preserves_literal_tags_and_rejects_second_scalar(self):
        schema = {'type': 'object', 'required': ['rows']}
        text = '{"rows": [], "text": "before<think>literal</think>after"}'
        self.assertEqual(command.mr.value_of(text, command.mr.prepare_schema(schema))['text'],
                         'before<think>literal</think>after')
        for content in ('true ' + text, text + ' false', '```json\n' + text + '\n``` false'):
            with self.subTest(content=content), self.assertRaises(ValueError):
                command.mr.value_of(content, command.mr.prepare_schema(schema))

    def test_resolvable_but_invalid_target_refused_before_dispatch(self):
        schema = {'$ref': '#/default', 'default': {'type': 'not-a-json-schema-type'}}
        with patch.object(command.subprocess, 'run') as run, self.assertRaises(ValueError):
            self.ask(json.dumps(receipt()), schema)
        run.assert_not_called()


    def test_nested_tool_claim_cannot_replace_controller_invocation(self):
        value = receipt(); value['result']['tool'] = 'tool:forged'
        answer = self.ask(json.dumps(value))
        self.assertEqual(answer[2]['tool'], 'tool:ask-a-model')
        self.assertEqual(answer[2]['owner_receipt']['tool'], 'tool:ask-a-model')

    def test_malformed_fence_opener_cannot_hide_another_value(self):
        validator = command.mr.prepare_schema({'type': 'object', 'required': ['rows']})
        for opener in ('```json``` true', '``` true', '```json false'):
            with self.subTest(opener=opener), self.assertRaises(ValueError):
                command.mr.value_of(opener + '\n{"rows": []}\n```', validator)

    def test_embedded_dialect_references_preflight_with_effective_specification(self):
        schema = {'$schema': 'https://json-schema.org/draft/2019-09/schema',
                  'type': 'object', '$defs': {'embedded': {
                      '$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': 'urn:embedded',
                      'type': 'object', 'properties': {'next': {'$dynamicRef': 'urn:missing'}}}}}
        with patch.object(command.subprocess, 'run') as run, self.assertRaises(ValueError):
            self.ask(json.dumps(receipt()), schema)
        run.assert_not_called()
        schema['$defs']['embedded']['properties']['next'] = {'$dynamicRef': '#/$defs/target'}
        schema['$defs']['embedded']['$defs'] = {'target': {'type': 'string'}}
        self.assertEqual(self.ask(json.dumps(receipt()), schema).value, {'rows': []})


    def test_invalid_embedded_dialect_schema_refused_before_dispatch(self):
        schema = {'$schema': 'https://json-schema.org/draft/2019-09/schema', '$defs': {'embedded': {
            '$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': 'urn:embedded',
            'prefixItems': [{'type': 'not-a-json-schema-type'}]}}}
        with patch.object(command.subprocess, 'run') as run, self.assertRaises(ValueError):
            self.ask(json.dumps(receipt()), schema)
        run.assert_not_called()


    def test_workshop_receipt_decodes_utf8_bytes_independently_of_locale(self):
        value = receipt(route='routé'); value['result']['model'] = 'modèle'
        completed = SimpleNamespace(returncode=0, stdout=json.dumps(value, ensure_ascii=False).encode('utf-8'), stderr=b'')
        with patch.object(command.subprocess, 'run', return_value=completed) as run:
            answer = command.Model({'transport': 'workshop', 'job': 'do-a-task-step', 'max_tokens': 2000}).ask('s', 'u')
        self.assertEqual((answer[2]['model'], answer[2]['served_by']), ('modèle', 'routé'))
        self.assertIsInstance(run.call_args.kwargs['input'], bytes)
        self.assertNotIn('text', run.call_args.kwargs)


    def test_valid_older_embedded_tuple_schema_keeps_its_own_dialect(self):
        schema = {'$schema':'https://json-schema.org/draft/2020-12/schema', 'type':'object',
                  '$defs':{'older':{'$schema':'http://json-schema.org/draft-07/schema#',
                                      'type':'array','items':[{'type':'object'}]}},
                  'properties':{'rows':{'$ref':'#/$defs/older'}}}
        self.assertEqual(self.ask(json.dumps(receipt()), schema).value, {'rows':[]})


class PhaseTest(unittest.TestCase):
    def test_binding_refuses_each_changed_input_without_writing(self):
        values = [{'transport': 'workshop'}, {'name': 'asks'}, {'video': 'words'}, {'videos': ['v']}]
        with tempfile.TemporaryDirectory() as folder:
            with command.ep.run(folder, *values): pass
            target = Path(folder); before = {p.name: p.read_bytes() for p in target.iterdir()}
            for index in range(4):
                changed = copy.deepcopy(values); changed[index]['changed'] = True
                with self.subTest(index=index), self.assertRaises(ValueError):
                    with command.ep.run(folder, *changed): pass
                self.assertEqual(before, {p.name: p.read_bytes() for p in target.iterdir()})

    def test_unbound_workshop_never_adopts_legacy_even_with_legacy_flag(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder); (target / 'done.jsonl').write_text('{"video":"old","rows":1}\n')
            before = {p.name: p.read_bytes() for p in target.iterdir()}
            for flag in (False, True):
                with self.subTest(flag=flag), self.assertRaises(ValueError):
                    with command.ep.run(folder, {'transport': 'workshop'}, {}, {}, {}, flag): pass
            self.assertEqual(before, {p.name: p.read_bytes() for p in target.iterdir()})
            with command.ep.run(folder, {'url': 'http://example.invalid', 'model': 'legacy'}, {}, {}, {}, True) as phase:
                self.assertIsNone(phase)
            self.assertEqual(before, {p.name: p.read_bytes() for p in target.iterdir()})

    def test_second_writer_is_refused_and_lock_releases(self):
        with tempfile.TemporaryDirectory() as folder:
            with command.ep.run(folder, {}, {}, {}, {}):
                with self.assertRaises(ValueError):
                    with command.ep.run(folder, {}, {}, {}, {}): pass
            with command.ep.run(folder, {}, {}, {}, {}): pass


    def test_drop_rule_order_is_bound_without_changing_rule_priority(self):
        first = {'drop_when':{'first':['x'], 'second':['y']}}
        changed = {'drop_when':{'second':['y'], 'first':['x']}}
        with tempfile.TemporaryDirectory() as folder:
            with command.ep.run(folder, {}, first, {}, {}): pass
            before = {p.name:p.read_bytes() for p in Path(folder).iterdir()}
            with self.assertRaisesRegex(ValueError, 'Extraction phase differs'):
                with command.ep.run(folder, {}, changed, {}, {}): pass
            self.assertEqual(before, {p.name:p.read_bytes() for p in Path(folder).iterdir()})


class WholeVideoTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        resolver = patch.object(command, "installed_model_cli", return_value="fixture-cli")
        resolver.start(); self.addCleanup(resolver.stop)
        (self.folder / 'corpus.jsonl').write_text(json.dumps({'id': 'v', 'channel': 'Test', 'title': 'Test', 'words': 8,
            'segs': [[0, 'one two three four five six seven eight']], 'duration': 5}) + '\n')
        (self.folder / 'asks.json').write_text(json.dumps({'name': 'test', 'system': 's', 'part_header': '[part {part}]',
            'rows_key': 'rows', 'part_field': 'part', 'quote_field': 'quote', 'chunk_words': 8}))
        (self.folder / 'model.json').write_text(json.dumps({'transport': 'workshop', 'job': 'do-a-task-step', 'max_tokens': 2000}))

    def args(self, **more):
        return argparse.Namespace(corpus=str(self.folder/'corpus.jsonl'), asks=str(self.folder/'asks.json'),
            model=str(self.folder/'model.json'), out=str(self.folder/'out'), channels=None, videos=None, limit=None,
            chunk_words=None, max_load=0, wait_for_model=0, attempts=2, retry_seconds=0, concurrency=1,
            report_every=100, coverage_out=None, **more)

    def completed(self, value):
        return SimpleNamespace(returncode=0, stdout=json.dumps(value), stderr='')

    def good(self, route='route-a'):
        return receipt(json.dumps({'rows': [{'part': 1, 'statement': 'A source idea',
            'quote': 'one two three four five six seven eight'}]}), route)

    def test_failed_attempt_then_success_preserves_rejected_evidence(self):
        bad = self.good(); bad['result']['choices'][0]['finish_reason'] = 'length'
        with patch.object(command.subprocess, 'run', side_effect=[self.completed(bad), self.completed(self.good())]):
            command.command_extract(self.args())
        failure = json.loads((self.folder/'out/failed.jsonl').read_text())
        self.assertFalse(failure['admitted'])
        self.assertEqual((failure['model_evidence']['model'], failure['model_evidence']['finish_reason']), ('reported', 'length'))
        done = json.loads((self.folder/'out/done.jsonl').read_text())
        self.assertEqual((done['rows'], done['failed_parts']), (1, 0))

    def test_duplicate_source_row_with_different_call_evidence_is_one_row(self):
        videos = self.folder/'order.txt'; videos.write_text('v\nv\n'); args = self.args(); args.videos = str(videos)
        other = self.good('route-b'); other['replayed'] = True
        with patch.object(command.subprocess, 'run', side_effect=[self.completed(self.good()), self.completed(other)]):
            command.command_extract(args)
        rows = [json.loads(line) for line in (self.folder/'out/Test.jsonl').read_text().splitlines()]
        done = json.loads((self.folder/'out/done.jsonl').read_text())
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(rows[0]['extraction_models']), 2)
        self.assertEqual(len(done['model_replies']), 2)
        self.assertEqual(rows[0]['id'], 'v@0#1')

    def test_bad_unicode_overflowing_number_and_oversized_usage_fail_then_retry(self):
        bad_values = []
        bad = self.good(); bad['result']['model'] = '\ud800'; bad['result']['choices'][0]['finish_reason'] = 'length'; bad_values.append(bad)
        bad = receipt('{"rows": [], "number": 1e400}'); bad_values.append(bad)
        bad = self.good(); bad['result']['usage']['prompt_tokens'] = 10 ** 400; bad_values.append(bad)
        for index, bad in enumerate(bad_values):
            with self.subTest(index=index):
                args = self.args(); args.out = str(self.folder / ('case-' + str(index)))
                with patch.object(command.subprocess, 'run', side_effect=[self.completed(bad), self.completed(self.good())]):
                    command.command_extract(args)
                target = Path(args.out)
                failures = [json.loads(line) for line in (target/'failed.jsonl').read_text(encoding='utf-8').splitlines()]
                self.assertEqual(len(failures), 1)
                self.assertFalse(failures[0]['admitted'])
                done = json.loads((target/'done.jsonl').read_text())
                self.assertEqual((done['rows'], done['failed_parts']), (1, 0))

    def test_coverage_aliases_refused_without_call_or_state_change(self):
        out = self.folder/'out'; out.mkdir()
        (out/'done.jsonl').write_text('{"video":"old","rows":1}\n')
        (out/'Test.jsonl').write_text('{"id":"old-row"}\n')
        aliases = [out/'done.jsonl', out/'Test.jsonl', out/'extraction-phase.json', self.folder/'corpus.jsonl',
                   self.folder/'asks.json', self.folder/'model.json']
        hard = self.folder/'hard-link'; hard.hardlink_to(self.folder/'corpus.jsonl'); aliases.append(hard)
        symbolic = self.folder/'symlink'; symbolic.symlink_to(self.folder/'asks.json'); aliases.append(symbolic)
        before = {str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file()}
        for path in aliases:
            args = self.args(); args.coverage_out = str(path)
            with self.subTest(path=path), patch.object(command.subprocess, 'run') as run, self.assertRaisesRegex(ValueError, 'Coverage destination'):
                command.command_extract(args)
            run.assert_not_called()
            self.assertEqual(before, {str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file()})

    def test_unique_coverage_temporary_does_not_touch_old_part_alias(self):
        destination = self.folder/'coverage.json'
        old_part = self.folder/'coverage.json.part'; old_part.hardlink_to(self.folder/'corpus.jsonl')
        original = (self.folder/'corpus.jsonl').read_bytes()
        command.ep.write_report(destination, {'checked': True})
        self.assertEqual((self.folder/'corpus.jsonl').read_bytes(), original)
        self.assertEqual(old_part.read_bytes(), original)
        self.assertEqual(json.loads(destination.read_text()), {'checked': True})

    def test_unicode_line_separator_survives_coverage_and_resume(self):
        value = self.good('route\u2028two'); content = json.loads(value['result']['choices'][0]['message']['content'])
        content['rows'][0]['statement'] = 'An idea\u2028with a separator'
        value['result']['choices'][0]['message']['content'] = json.dumps(content, ensure_ascii=False)
        args = self.args(); args.coverage_out = str(self.folder/'coverage.json')
        with patch.object(command.subprocess, 'run', return_value=self.completed(value)):
            command.command_extract(args)
        done = command.read_done(str(self.folder/'out/done.jsonl'))
        rows = [json.loads(line) for _, _, line in command.read_lines(str(self.folder/'out/Test.jsonl'))]
        self.assertEqual(done['v']['model_replies'][0]['served_by'], 'route\u2028two')
        self.assertEqual(rows[0]['statement'], 'An idea\u2028with a separator')
        with patch.object(command.subprocess, 'run') as no_call:
            result = command.command_extract(args)
        no_call.assert_not_called(); self.assertEqual(result['videos'], 0)
        self.assertEqual(json.loads((self.folder/'coverage.json').read_text())['totals']['rows'], 1)

    def test_provider_cannot_supply_collector_provenance(self):
        videos = self.folder/'order.txt'; videos.write_text('v\nv\n'); args = self.args(); args.videos = str(videos)
        supplied = self.good(); content = json.loads(supplied['result']['choices'][0]['message']['content'])
        content['rows'][0]['extraction_models'] = 'provider-forgery'
        supplied['result']['choices'][0]['message']['content'] = json.dumps(content)
        other = copy.deepcopy(supplied); other['result']['served_by'] = 'route-b'
        with patch.object(command.subprocess, 'run', side_effect=[self.completed(supplied), self.completed(other)]):
            command.command_extract(args)
        rows = [json.loads(line) for _, _, line in command.read_lines(str(self.folder/'out/Test.jsonl'))]
        self.assertEqual(len(rows), 1)
        self.assertEqual([p['served_by'] for p in rows[0]['extraction_models']], ['route-a', 'route-b'])

    def test_fresh_case_collisions_fail_specifically_before_directory_or_calls(self):
        args = self.args(); args.coverage_out = str(self.folder/'out/FAILED.jsonl')
        with patch.object(command.subprocess, 'run') as no_call, self.assertRaisesRegex(ValueError, 'Coverage destination'):
            command.command_extract(args)
        no_call.assert_not_called(); self.assertFalse((self.folder/'out').exists())

    def test_report_rechecks_full_protected_set_before_replace(self):
        state = self.folder/'failed.jsonl'; state.write_text('kept failure evidence\n')
        destination = self.folder/'report.json'; original = command.ep.tempfile.mkstemp
        def created_alias(*args, **kwargs):
            result = original(*args, **kwargs); destination.hardlink_to(state); return result
        with patch.object(command.ep.tempfile, 'mkstemp', side_effect=created_alias), self.assertRaisesRegex(ValueError, 'Coverage destination'):
            command.ep.write_report(destination, {'report': True}, [state])
        self.assertEqual(state.read_text(), 'kept failure evidence\n')

    def test_bad_row_container_and_consumed_fields_fail_then_retry(self):
        values = [receipt('{"rows": null}'), receipt('{"rows": false}'), receipt('{"rows": 4}'),
                  receipt('{"rows": [{"part": 1,"quote": 1,"statement": "bad"}]}')]
        for index, bad in enumerate(values):
            args = self.args(); args.out = str(self.folder/('bad-row-' + str(index)))
            with self.subTest(index=index), patch.object(command.subprocess, 'run', side_effect=[self.completed(bad), self.completed(self.good())]):
                command.command_extract(args)
            failed = [json.loads(line) for _, _, line in command.read_lines(str(Path(args.out)/'failed.jsonl'))]
            self.assertEqual(len(failed), 1); self.assertFalse(failed[0]['admitted'])
            self.assertEqual(command.read_done(str(Path(args.out)/'done.jsonl'))['v']['rows'], 1)


    def test_literal_checkpoint_and_internal_coverage_paths_with_glob_characters(self):
        args = self.args(); args.out = str(self.folder/'run[1]'); args.coverage_out = str(self.folder/'coverage.json')
        sibling = self.folder/'run1'; sibling.mkdir(); (sibling/'done.jsonl').write_text('{"video":"other"}\n')
        with patch.object(command.subprocess, 'run', return_value=self.completed(self.good())):
            command.command_extract(args)
        before = {p.name:p.read_bytes() for p in Path(args.out).iterdir()}
        with patch.object(command.subprocess, 'run') as no_call:
            result = command.command_extract(args)
        no_call.assert_not_called(); self.assertEqual(result['videos'], 0)
        self.assertEqual(before, {p.name:p.read_bytes() for p in Path(args.out).iterdir()})
        self.assertEqual(json.loads((self.folder/'coverage.json').read_text())['totals']['rows'], 1)

    def test_coverage_cannot_overwrite_channel_sidecars(self):
        args = self.args(); args.coverage_out = str(self.folder/'out/Test.nxn.json')
        with patch.object(command.subprocess, 'run') as no_call, self.assertRaisesRegex(ValueError, 'Coverage destination'):
            command.command_extract(args)
        no_call.assert_not_called(); self.assertFalse((self.folder/'out').exists())
        rows = self.folder/'Test.jsonl'; rows.write_text('{"sources":[{"video":"v"}]}\n')
        sidecar = self.folder/'Test.nxn.json'; sidecar.write_text('{"kept":"sidecar metadata"}\n')
        before = sidecar.read_bytes()
        with self.assertRaisesRegex(ValueError, 'Coverage destination'):
            command.command_coverage(argparse.Namespace(corpus=str(self.folder/'corpus.jsonl'), rows=[str(rows)],
                                                       done=None, out=str(sidecar)))
        self.assertEqual(sidecar.read_bytes(), before)


    def test_fresh_output_directory_cannot_also_be_the_coverage_file(self):
        args = self.args(); args.coverage_out = args.out
        with patch.object(command.subprocess, 'run') as no_call, self.assertRaisesRegex(ValueError, 'Coverage destination'):
            command.command_extract(args)
        no_call.assert_not_called(); self.assertFalse(Path(args.out).exists())

    def test_configured_http_preserves_schema_valid_single_row_and_bare_array(self):
        row = {'quote': 'one two three four five six seven eight', 'statement': 'A source idea'}
        (self.folder/'model.json').write_text(json.dumps({'url': 'http://example.invalid/v1', 'model': 'requested'}))
        for name, value, schema in [('single-row', row, {'type': 'object', 'required': ['quote']}),
                                    ('bare-array', [row], {'type': 'array', 'items': {'type': 'object', 'required': ['quote']}})]:
            asks = json.loads((self.folder/'asks.json').read_text()); asks['reply_schema'] = schema
            (self.folder/'asks.json').write_text(json.dumps(asks))
            args = self.args(); args.out = str(self.folder/name)
            reply = receipt(json.dumps(value))['result']
            with patch.object(command.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(reply).encode())):
                result = command.command_extract(args)
            self.assertEqual(result['rows'], 1)


    def test_fresh_ancestor_coverage_path_refused_before_creation(self):
        for spelling in ('fresh', 'FRESH'):
            args = self.args(); args.out = str(self.folder/'fresh/rows'); args.coverage_out = str(self.folder/spelling)
            with patch.object(command.subprocess, 'run') as no_call, self.assertRaisesRegex(ValueError, 'Coverage destination'):
                command.command_extract(args)
            no_call.assert_not_called(); self.assertFalse((self.folder/'fresh').exists())

    def test_explicit_null_schema_refused_before_dispatch_for_both_transports(self):
        asks = json.loads((self.folder/'asks.json').read_text()); asks['reply_schema'] = None
        (self.folder/'asks.json').write_text(json.dumps(asks))
        for model in ({'url': 'http://example.invalid/v1', 'model': 'requested'},
                      {'transport': 'workshop', 'job': 'do-a-task-step', 'max_tokens': 2000}):
            (self.folder/'model.json').write_text(json.dumps(model))
            with patch.object(command.subprocess, 'run') as no_call, patch.object(command.urllib.request, 'urlopen') as http, \
                    self.assertRaisesRegex(ValueError, 'reply_schema cannot be null'):
                command.command_extract(self.args())
            no_call.assert_not_called(); http.assert_not_called(); self.assertFalse((self.folder/'out').exists())


    def test_fractional_wire_number_cannot_round_into_an_integer_then_complete(self):
        bad = receipt('{"rows": [{"part": 1.0000000000000001, "statement": "An idea", "quote": "one two three four five six seven eight"}]}')
        with patch.object(command.subprocess, 'run', side_effect=[self.completed(bad), self.completed(self.good())]):
            result = command.command_extract(self.args())
        self.assertEqual(result['rows'], 1)
        failures = [json.loads(line) for _,_,line in command.read_lines(str(self.folder/'out/failed.jsonl'))]
        self.assertEqual(len(failures), 1); self.assertFalse(failures[0]['admitted'])
        self.assertEqual(command.mr.strict_json('[0.1, 0.3, 1.0, 1e3]'), [0.1, 0.3, 1.0, 1000.0])
        with self.assertRaises(ValueError): command.mr.strict_json('1e-400')

    def test_coverage_reads_one_frozen_glob_expansion(self):
        initial = self.folder/'first.jsonl'; initial.write_text('{"sources":[{"video":"v"}]}\n')
        late = self.folder/'late.jsonl'
        def discover(pattern):
            late.write_text('{"sources":[{"video":"v"}]}\n')
            return [str(initial)]
        with patch.object(command.glob, 'glob', side_effect=discover) as discover_call:
            result = command.command_coverage(argparse.Namespace(corpus=str(self.folder/'corpus.jsonl'),
                rows=[str(self.folder/'*.jsonl')], done=None, out=str(self.folder/'coverage.json')))
        self.assertEqual(discover_call.call_count, 1); self.assertEqual(result['rows'], 1)
        self.assertEqual(late.read_text(), '{"sources":[{"video":"v"}]}\n')

    def test_report_below_protected_file_refused_but_under_output_directory_works(self):
        args = self.args(); args.coverage_out = str(self.folder/'out/done.jsonl/report.json')
        with patch.object(command.subprocess, 'run') as no_call, self.assertRaisesRegex(ValueError, 'Coverage destination'):
            command.command_extract(args)
        no_call.assert_not_called(); self.assertFalse((self.folder/'out').exists())
        args.coverage_out = str(self.folder/'out/coverage.json')
        with patch.object(command.subprocess, 'run', return_value=self.completed(self.good())):
            command.command_extract(args)
        self.assertEqual(json.loads((self.folder/'out/coverage.json').read_text())['totals']['rows'], 1)


    def test_extreme_decimal_exponents_fail_as_recorded_attempts_then_retry(self):
        for index, literal in enumerate(('0e999999999999999999999', '1e-999999999999999999999')):
            args = self.args(); args.out = str(self.folder/('extreme-exponent-' + str(index)))
            bad = receipt('{"rows":[],"n":' + literal + '}')
            with patch.object(command.subprocess, 'run', side_effect=[self.completed(bad), self.completed(self.good())]) as call:
                result = command.command_extract(args)
            self.assertEqual(call.call_count, 2); self.assertEqual(result['rows'], 1)
            failures = [json.loads(line) for _,_,line in command.read_lines(str(Path(args.out)/'failed.jsonl'))]
            self.assertEqual(len(failures), 1); self.assertFalse(failures[0]['admitted'])
            self.assertIn('model_evidence', failures[0])


    def test_legacy_continuation_preserves_retained_channels_outside_current_corpus(self):
        args = self.args(); args.legacy_unbound_http = True
        (self.folder/'model.json').write_text(json.dumps({'url': 'http://example.invalid/v1', 'model': 'legacy'}))
        out = self.folder/'out'; out.mkdir()
        (out/'done.jsonl').write_text('{"video":"retained-other-channel","rows":1}\n')
        retained = out/'Other-Channel.jsonl'; retained.write_text('{"id":"retained","sources":[{"video":"retained-other-channel"}]}\n')
        sidecar = out/'Other-Channel.nxn.json'; sidecar.write_text('{"kept":"original source metadata"}\n')
        before = {p.name:p.read_bytes() for p in out.iterdir()}
        for destination in (retained, sidecar):
            args.coverage_out = str(destination)
            with patch.object(command.subprocess, 'run') as cli, patch.object(command.urllib.request, 'urlopen') as http, \
                    self.assertRaisesRegex(ValueError, 'Coverage destination'):
                command.command_extract(args)
            cli.assert_not_called(); http.assert_not_called()
            self.assertEqual(before, {p.name:p.read_bytes() for p in out.iterdir()})


    def test_future_reserved_report_suffixes_refused_before_dispatch(self):
        for suffix in ('.jsonl', '.JSONL', '.nxn.json', '.NxN.JsOn'):
            args = self.args(); args.coverage_out = str(self.folder/('out/report' + suffix))
            with patch.object(command.subprocess, 'run') as no_call, self.assertRaisesRegex(ValueError, 'Coverage destination'):
                command.command_extract(args)
            no_call.assert_not_called(); self.assertFalse((self.folder/'out').exists())

    def test_retained_suffix_inventory_is_case_folded(self):
        out = self.folder/'out'; out.mkdir()
        row = out/'Other-Channel.JsOnL'; row.write_text('{"id":"retained"}\n')
        sidecar = out/'Other-Channel.NxN.JsOn'; sidecar.write_text('{"kept":"metadata"}\n')
        before = {p.name:p.read_bytes() for p in out.iterdir()}
        for destination in (self.folder/'report-row', self.folder/'report-sidecar'):
            destination.hardlink_to(row if destination.name.endswith('row') else sidecar)
            args = self.args(); args.coverage_out = str(destination)
            with patch.object(command.subprocess, 'run') as no_call, self.assertRaisesRegex(ValueError, 'Coverage destination'):
                command.command_extract(args)
            no_call.assert_not_called(); self.assertEqual(before, {p.name:p.read_bytes() for p in out.iterdir()})

    def test_missing_report_parents_not_created_by_output_setup_refuse_before_dispatch(self):
        for destination in (self.folder/'reports/coverage.json', self.folder/'out/reports/coverage.json'):
            args = self.args(); args.coverage_out = str(destination)
            with patch.object(command.subprocess, 'run') as no_call, self.assertRaisesRegex(ValueError, 'Coverage destination'):
                command.command_extract(args)
            no_call.assert_not_called(); self.assertFalse((self.folder/'out').exists())


    def test_report_uses_validated_parent_even_with_missing_dotdot_component(self):
        args = self.args(); args.coverage_out = str(self.folder/'out/missing/../coverage.json'); args.report_every = 1
        with patch.object(command.subprocess, 'run', return_value=self.completed(self.good())):
            result = command.command_extract(args)
        self.assertEqual(result['rows'], 1)
        self.assertEqual(json.loads((self.folder/'out/coverage.json').read_text())['totals']['rows'], 1)
        self.assertFalse((self.folder/'out/missing').exists())

    def test_mixed_case_nonempty_rows_refuse_workshop_unbound_adoption(self):
        out = self.folder/'out'; out.mkdir(); (out/'old.JsOnL').write_text('{"id":"retained"}\n')
        before = {p.name:p.read_bytes() for p in out.iterdir()}
        for legacy_flag in (False, True):
            args = self.args(); args.legacy_unbound_http = legacy_flag
            with patch.object(command.subprocess, 'run') as no_call, self.assertRaisesRegex(ValueError, 'Unbound extraction data'):
                command.command_extract(args)
            no_call.assert_not_called(); self.assertEqual(before, {p.name:p.read_bytes() for p in out.iterdir()})
        with command.ep.run(out, {'transport':'http'}, {}, {}, {}, legacy_unbound_http=True) as phase:
            self.assertIsNone(phase)
        self.assertEqual(before, {p.name:p.read_bytes() for p in out.iterdir()})


    def test_reserved_suffix_uses_named_parent_and_preserves_outside_alias_target(self):
        out = self.folder/'out'; out.mkdir(); external = self.folder/'external.json'; external.write_text('{"preserved":true}')
        inside = out/'report.JSONL'; inside.symlink_to(external)
        with self.assertRaisesRegex(ValueError, 'retained-data suffix'):
            command.ep.refuse_alias(inside, [], directories=[out])
        target = out/'other.json'; target.write_text('{"preserved":true}'); outside = self.folder/'outside.JSONL'; outside.symlink_to(target)
        command.ep.write_report(outside, {'report': True}, directories=[out])
        self.assertFalse(outside.is_symlink()); self.assertEqual(json.loads(outside.read_text()), {'report': True})
        self.assertEqual(target.read_text(), '{"preserved":true}')

    def test_long_valid_report_name_does_not_inflate_temporary_name(self):
        limit = command.os.pathconf(self.folder, 'PC_NAME_MAX')
        if not 32 < limit < 4096: self.skipTest('filesystem has no bounded component length suitable for this control')
        args = self.args(); args.coverage_out = str(self.folder/'out'/('r'*(limit-5)+'.json')); args.report_every = 1
        with patch.object(command.subprocess, 'run', return_value=self.completed(self.good())):
            result = command.command_extract(args)
        self.assertEqual(result['rows'], 1)
        self.assertEqual(json.loads(Path(args.coverage_out).read_text())['totals']['rows'], 1)

    def test_overlong_final_report_name_refuses_before_dispatch(self):
        limit = command.os.pathconf(self.folder, 'PC_NAME_MAX')
        if not 32 < limit < 4096: self.skipTest('filesystem has no bounded component length suitable for this control')
        args = self.args(); args.coverage_out = str(self.folder/'out'/('r'*(limit+1)))
        with patch.object(command.subprocess, 'run') as no_call, self.assertRaisesRegex(ValueError, 'component limit'):
            command.command_extract(args)
        no_call.assert_not_called(); self.assertFalse((self.folder/'out').exists())


    def test_sidecar_only_unbound_directory_is_not_adopted_by_workshop(self):
        out = self.folder/'out'; out.mkdir(); (out/'old.NxN.JsOn').write_text('{"retained":"source metadata"}\n')
        before = {p.name:p.read_bytes() for p in out.iterdir()}
        with patch.object(command.subprocess, 'run') as no_call, self.assertRaisesRegex(ValueError, 'Unbound extraction data'):
            command.command_extract(self.args())
        no_call.assert_not_called(); self.assertEqual(before, {p.name:p.read_bytes() for p in out.iterdir()})


    def test_reference_visit_under_root_dialect_cannot_hide_embedded_dynamic_reference(self):
        schema = {'$schema': 'https://json-schema.org/draft/2019-09/schema',
                  '$ref': '#/$defs/embedded/properties/child', '$defs': {'embedded': {
                      '$schema': 'https://json-schema.org/draft/2020-12/schema',
                      'type': 'object', 'properties': {'child': {'$dynamicRef': 'urn:missing'}}}}}
        with patch.object(command.subprocess, 'run') as run, self.assertRaises(ValueError):
            command.Model({'transport':'workshop','job':'do-a-task-step','max_tokens':2000}).ask('s','u',schema)
        run.assert_not_called()


    def test_schema_and_profile_documents_are_strict_before_dispatch(self):
        good_asks = (self.folder/'asks.json').read_text(); good_profile = (self.folder/'model.json').read_text()
        cases = [('asks.json', '{"reply_schema":{"minimum":1.0000000000000001}}'),
                 ('asks.json', '{"reply_schema":{},"reply_schema":{}}'),
                 ('model.json', '{"transport":"http","transport":"workshop","job":"do-a-task-step","max_tokens":2000}'),
                 ('model.json', '{"transport":"workshop","job":"do-a-task-step","max_tokens":2000,"body":{"temperature":1.0000000000000001}}')]
        for name, text in cases:
            (self.folder/'asks.json').write_text(good_asks); (self.folder/'model.json').write_text(good_profile)
            (self.folder/name).write_text(text)
            with patch.object(command.subprocess, 'run') as cli, patch.object(command.urllib.request, 'urlopen') as http, self.assertRaises(ValueError):
                command.command_extract(self.args())
            cli.assert_not_called(); http.assert_not_called(); self.assertFalse((self.folder/'out').exists())

    def test_http_incomplete_read_is_recorded_then_complete_reply_retries(self):
        class BrokenBody(io.BytesIO):
            def read(self, *args): raise command.http.client.IncompleteRead(b'partial', 10)
        (self.folder/'model.json').write_text(json.dumps({'url':'http://example.invalid/v1','model':'requested'}))
        complete = io.BytesIO(json.dumps(self.good()['result']).encode())
        with patch.object(command.urllib.request, 'urlopen', side_effect=[BrokenBody(),complete]) as http:
            result = command.command_extract(self.args())
        self.assertEqual(http.call_count, 2); self.assertEqual(result['rows'], 1)
        failed = [json.loads(line) for _,_,line in command.read_lines(str(self.folder/'out/failed.jsonl'))]
        self.assertEqual(len(failed),1); self.assertFalse(failed[0]['admitted'])
        self.assertEqual(failed[0]['model_evidence']['requested_model'], 'requested')

    def test_http_body_reset_consumes_recorded_attempt_not_reachability_wait(self):
        class ResetBody(io.BytesIO):
            def read(self, *args): raise ConnectionResetError('fixture reset after headers')
        (self.folder/'model.json').write_text(json.dumps({'url':'http://example.invalid/v1','model':'requested'}))
        for attempts in (1, 2):
            args = self.args(); args.attempts = attempts; args.wait_for_model = 60
            args.out = str(self.folder/('reset-' + str(attempts)))
            complete = io.BytesIO(json.dumps(self.good()['result']).encode())
            with patch.object(command.urllib.request, 'urlopen', side_effect=[ResetBody(),complete]) as http, \
                    patch.object(command.time, 'sleep') as sleep:
                result = command.command_extract(args)
            self.assertEqual(http.call_count, attempts)
            self.assertEqual([inv.args for inv in sleep.call_args_list], [] if attempts == 1 else [(0,)])
            self.assertEqual(result['rows'], 1 if attempts == 2 else 0)
            failed = [json.loads(line) for _,_,line in command.read_lines(str(Path(args.out)/'failed.jsonl'))]
            self.assertEqual(len(failed), 1); self.assertFalse(failed[0]['admitted'])
            self.assertEqual(failed[0]['model_evidence']['requested_model'], 'requested')

    def test_http_unknown_stage_reset_consumes_attempt_but_connect_refusal_can_wait(self):
        (self.folder/'model.json').write_text(json.dumps({'url':'http://example.invalid/v1','model':'requested'}))
        errors = [ConnectionResetError('fixture header reset'), command.urllib.error.URLError(ConnectionResetError('fixture wrapped reset')),
                  command.urllib.error.URLError(ConnectionRefusedError('fixture connect refused'))]
        for index, error in enumerate(errors):
            args = self.args(); args.out = str(self.folder/('header-' + str(index))); args.wait_for_model = 60
            complete = io.BytesIO(json.dumps(self.good()['result']).encode())
            with patch.object(command.urllib.request, 'urlopen', side_effect=[error,complete]) as http, patch.object(command.time,'sleep') as sleep:
                result = command.command_extract(args)
            self.assertEqual(http.call_count,2); self.assertEqual(result['rows'],1)
            failed = [json.loads(line) for _,_,line in command.read_lines(str(Path(args.out)/'failed.jsonl'))]
            self.assertEqual(len(failed), 0 if index == 2 else 1)
            self.assertEqual([inv.args for inv in sleep.call_args_list], [(30,)] if index == 2 else [(0,)])
            if failed: self.assertEqual(failed[0]['model_evidence']['requested_model'], 'requested')

    def test_existing_state_targets_cannot_alias_by_inode_or_symlink(self):
        original = (self.folder/'corpus.jsonl').read_bytes()
        for index, kind in enumerate(('hardlink-ledger','hardlink-outside','symlink','input')):
            folder = self.folder/('aliased-' + str(index)); folder.mkdir(); args = self.args(); args.out = str(folder)
            row = folder/'Test.jsonl'
            if kind == 'hardlink-ledger': row.touch(); (folder/'done.jsonl').hardlink_to(row)
            elif kind == 'hardlink-outside':
                other = self.folder/'outside.jsonl'; other.touch(); row.hardlink_to(other)
            elif kind == 'symlink': row.symlink_to(self.folder/'outside-new.jsonl')
            else: row.hardlink_to(self.folder/'corpus.jsonl')
            before = {p.name:(p.is_symlink(), p.readlink() if p.is_symlink() else p.read_bytes()) for p in folder.iterdir()}
            with patch.object(command.subprocess, 'run') as call, self.assertRaisesRegex(ValueError, 'Extraction state target'):
                command.command_extract(args)
            call.assert_not_called()
            self.assertEqual(before,{p.name:(p.is_symlink(),p.readlink() if p.is_symlink() else p.read_bytes()) for p in folder.iterdir()})
            self.assertEqual((self.folder/'corpus.jsonl').read_bytes(),original)

    def test_bound_rows_require_matching_phase_before_resume_or_coverage(self):
        args = self.args()
        with patch.object(command.subprocess, 'run',return_value=self.completed(self.good())):
            command.command_extract(args)
        path = self.folder/'out/Test.jsonl'; original = json.loads(path.read_text()); phase = original['extraction_phase']
        for value in ('other-phase',None):
            row = {**original,'extraction_phase':value}
            if value is None:del row['extraction_phase']
            path.write_text(json.dumps(row)+'\n'); before={p.name:p.read_bytes() for p in path.parent.iterdir()}
            with patch.object(command.subprocess,'run') as call,self.assertRaisesRegex(ValueError,'Retained row phase'):
                command.command_extract(args)
            call.assert_not_called();self.assertEqual(before,{p.name:p.read_bytes() for p in path.parent.iterdir()})
            coverage = argparse.Namespace(corpus=args.corpus, rows=[str(path)],done=str(path.parent/'done.jsonl'),out=None,
                                          literal_rows=True, kept_rows=True, expected_phase=phase)
            with self.assertRaisesRegex(ValueError,'Retained row phase'):command.command_coverage(coverage)

    def test_provider_ids_do_not_split_one_controller_finding(self):
        videos = self.folder/'order.txt'; videos.write_text('v\nv\n');args=self.args();args.videos=str(videos)
        replies=[]
        for index in range(2):
            value=self.good('route-'+str(index));body=json.loads(value['result']['choices'][0]['message']['content'])
            body['rows'][0]['id']='provider-id-'+str(index);value['result']['choices'][0]['message']['content']=json.dumps(body)
            replies.append(self.completed(value))
        with patch.object(command.subprocess,'run',side_effect=replies):result=command.command_extract(args)
        self.assertEqual(result['rows'],1)
        row=json.loads((self.folder/'out/Test.jsonl').read_text());self.assertEqual(row['id'],'v@0#1')
        self.assertEqual([m['served_by'] for m in row['extraction_models']],['route-0','route-1'])

    def test_internal_sidecar_cannot_point_to_a_ledger(self):
        args=self.args();args.coverage_out=str(self.folder/'coverage.json')
        with patch.object(command.subprocess,'run',return_value=self.completed(self.good())):command.command_extract(args)
        out=self.folder/'out';sidecar=out/'Test.nxn.json';sidecar.symlink_to(out/'done.jsonl')
        before={p.name:p.read_bytes() for p in out.iterdir()};report_before=(self.folder/'coverage.json').read_bytes()
        with patch.object(command.subprocess,'run') as call,self.assertRaisesRegex(ValueError,'Extraction state target'):
            command.command_extract(args)
        call.assert_not_called();self.assertEqual(before,{p.name:p.read_bytes() for p in out.iterdir()})
        self.assertEqual(report_before,(self.folder/'coverage.json').read_bytes())
        sidecar.unlink();sidecar.write_text('{"kept":"source metadata"}')
        with patch.object(command.subprocess,'run') as call:command.command_extract(args)
        call.assert_not_called()
        report=json.loads((self.folder/'coverage.json').read_text());self.assertTrue(report['row_files'][0]['sidecar'].endswith('Test.nxn.json'))

    def test_guest_object_member_order_does_not_change_attribution(self):
        rule=[{'field':'guests','pattern':"'name': '(?P<name>[^']+)'"}]
        first={'guests':{'one':{'name':'Alice'},'two':{'name':'Bob'}}}
        second={'guests':{'two':{'name':'Bob'},'one':{'name':'Alice'}}}
        self.assertEqual(command.ep.identity(first),command.ep.identity(second))
        self.assertEqual(command.x.guest_of(rule,first),'Alice')
        self.assertEqual(command.x.guest_of(rule,first),command.x.guest_of(rule,second))

    def test_timeout_captured_receipt_is_diagnostic_only(self):
        for index, captured in enumerate((json.dumps(self.good()).encode(),b'{"exit_code":0')):
            args=self.args();args.attempts=1;args.out=str(self.folder/('timeout-'+str(index)))
            error=command.subprocess.TimeoutExpired(['fixture-cli'],1,output=captured)
            with patch.object(command.subprocess,'run',side_effect=error):result=command.command_extract(args)
            self.assertEqual(result['rows'],0);self.assertEqual(result['failed_parts'],1)
            failure=json.loads((Path(args.out)/'failed.jsonl').read_text());evidence=failure['model_evidence']
            self.assertTrue(evidence['cli_timed_out']);self.assertNotIn('cli_exit_code',evidence)
            if index==0:
                self.assertEqual((evidence['model'],evidence['served_by'],evidence['finish_reason']),('reported','route-a','stop'))
                self.assertEqual(evidence['owner_receipt']['exit_code'],0)
            else:self.assertNotIn('model',evidence);self.assertNotIn('owner_receipt',evidence)

    def test_equal_numeric_content_merges_without_changing_kept_value(self):
        value=self.good();row=json.loads(value['result']['choices'][0]['message']['content'])['rows'][0]
        for index, pair in enumerate(((1,1.0),(10**23,1e23),(0,-0.0))):
            args=self.args();args.out=str(self.folder/('numeric-'+str(index)))
            rows=[{**row,'custom':{'value':number}} for number in pair]
            reply=self.good();reply['result']['choices'][0]['message']['content']=json.dumps({'rows':rows})
            with patch.object(command.subprocess,'run',return_value=self.completed(reply)):result=command.command_extract(args)
            self.assertEqual(result['rows'],1)
            kept=json.loads((Path(args.out)/'Test.jsonl').read_text());self.assertIs(type(kept['custom']['value']),int)
            self.assertEqual(kept['custom']['value'],pair[0])

    def test_old_guest_semantics_partial_phase_cannot_resume(self):
        corpus=self.folder/'corpus.jsonl';v=json.loads(corpus.read_text());v['guest_roles']={'two':{'name':'Bob'},'one':{'name':'Alice'}}
        corpus.write_text(json.dumps(v)+'\n'+json.dumps({**v,'id':'w'})+'\n')
        asks=json.loads((self.folder/'asks.json').read_text());asks['guest_from']=[{'field':'guest_roles','pattern':"'name': '(?P<name>[^']+)'"}]
        (self.folder/'asks.json').write_text(json.dumps(asks));args=self.args();args.limit=1
        with patch.object(command.subprocess,'run',return_value=self.completed(self.good())):command.command_extract(args)
        folder=self.folder/'out';manifest=json.loads((folder/'extraction-phase.json').read_text())
        old_binding={k:v for k,v in manifest['binding'].items() if k!='semantics'};old_phase=command.ep.identity(old_binding)
        (folder/'extraction-phase.json').write_text(json.dumps({'version':1,'binding':old_binding,'phase_id':old_phase}))
        row=json.loads((folder/'Test.jsonl').read_text());row['extraction_phase']=old_phase;row['sources'][0]['guest']='Bob'
        (folder/'Test.jsonl').write_text(json.dumps(row)+'\n');done=json.loads((folder/'done.jsonl').read_text());done['extraction_phase']=old_phase
        (folder/'done.jsonl').write_text(json.dumps(done)+'\n');before={p.name:p.read_bytes() for p in folder.iterdir()};args.limit=None
        with patch.object(command.subprocess,'run') as cli,self.assertRaisesRegex(ValueError,'Extraction phase differs'):command.command_extract(args)
        cli.assert_not_called();self.assertEqual(before,{p.name:p.read_bytes() for p in folder.iterdir()})

    def test_nested_rejected_receipt_claims_cannot_replace_dispatch_identity(self):
        for index, kind in enumerate(('timeout','strict-reject')):
            args=self.args();args.out=str(self.folder/('conflicting-diagnostics-'+str(index)));args.attempts=1
            value=self.good();value['result'].update(tool='tool:other',exit_code=900,replayed=True)
            if kind=='strict-reject':value['result']['provider_note']='\ud800'
            raw=json.dumps(value).encode()
            effect=command.subprocess.TimeoutExpired(['fixture-cli'],1,output=raw) if kind=='timeout' else None
            with patch.object(command.subprocess,'run',side_effect=effect,return_value=SimpleNamespace(returncode=0,stdout=raw,stderr=b'')):
                result=command.command_extract(args)
            self.assertEqual(result['rows'],0)
            e=json.loads((Path(args.out)/'failed.jsonl').read_text())['model_evidence']
            self.assertEqual(e['tool'],'tool:ask-a-model');self.assertNotIn('exit_code',e);self.assertNotIn('replayed',e)
            self.assertEqual(e['owner_receipt'],{'exit_code':0,'tool':'tool:ask-a-model','replayed':False})
            self.assertEqual((e['model'],e['served_by']),('reported','route-a'))

    def test_deep_admitted_custom_content_deduplicates_without_collector_recursion(self):
        nested=0
        for _ in range(600):nested=[nested]
        value=self.good();row=json.loads(value['result']['choices'][0]['message']['content'])['rows'][0]
        row['custom']=nested;value['result']['choices'][0]['message']['content']=json.dumps({'rows':[row,row]})
        with patch.object(command.subprocess,'run',return_value=self.completed(value)):
            result=command.command_extract(self.args())
        self.assertEqual(result['rows'],1);self.assertEqual(result['failed_parts'],0)
        kept=json.loads((self.folder/'out/Test.jsonl').read_text());depth=0;cursor=kept['custom']
        while isinstance(cursor,list):depth+=1;cursor=cursor[0]
        self.assertEqual((depth,cursor),(600,0));self.assertEqual((self.folder/'out/failed.jsonl').read_text(),'')

    def test_changed_installed_site_command_refuses_bound_resume(self):
        args=self.args()
        with patch.object(command.subprocess,'run',return_value=self.completed(self.good())):
            command.command_extract(args)
        folder=self.folder/'out';before={p.name:p.read_bytes() for p in folder.iterdir()}
        with patch.object(command,'installed_model_cli',return_value='other-site'),patch.object(command.subprocess,'run') as model_call, \
                self.assertRaisesRegex(ValueError,'Extraction phase differs'):
            command.command_extract(args)
        model_call.assert_not_called();self.assertEqual(before,{p.name:p.read_bytes() for p in folder.iterdir()})

    def test_channel_files_cannot_alias_ledgers_or_each_other(self):
        source = json.loads((self.folder/'corpus.jsonl').read_text())
        for channel in ('done', 'Done', 'failed', 'DROPPED', '---done---'):
            (self.folder/'corpus.jsonl').write_text(json.dumps({**source,'channel':channel})+'\n')
            with patch.object(command.subprocess, 'run') as call, self.assertRaisesRegex(ValueError, 'Channel output'):
                command.command_extract(self.args())
            call.assert_not_called(); self.assertFalse((self.folder/'out').exists())
        (self.folder/'corpus.jsonl').write_text(json.dumps({**source,'channel':'A+B'})+'\n'+json.dumps({**source,'id':'other','channel':'A-B'})+'\n')
        with patch.object(command.subprocess, 'run') as call, self.assertRaisesRegex(ValueError, 'Channel output'):
            command.command_extract(self.args())
        call.assert_not_called(); self.assertFalse((self.folder/'out').exists())

    def test_bound_checkpoints_require_matching_phase_before_skip(self):
        with patch.object(command.subprocess, 'run', return_value=self.completed(self.good())):
            command.command_extract(self.args())
        done = self.folder/'out/done.jsonl'; original = json.loads(done.read_text())
        for phase in ('blake3:other-phase', None):
            entry = {**original,'extraction_phase':phase}
            if phase is None: del entry['extraction_phase']
            done.write_text(json.dumps(entry)+'\n')
            before = {p.name:p.read_bytes() for p in done.parent.iterdir()}
            with patch.object(command.subprocess, 'run') as call, self.assertRaisesRegex(ValueError, 'Checkpoint phase'):
                command.command_extract(self.args())
            call.assert_not_called(); self.assertEqual(before,{p.name:p.read_bytes() for p in done.parent.iterdir()})

    def test_internal_coverage_uses_bound_corpus_after_live_file_refresh(self):
        args = self.args(); args.coverage_out = str(self.folder/'coverage.json'); args.report_every = 1
        source = self.folder/'corpus.jsonl'
        def model(*unused, **kwargs):
            value = json.loads(source.read_text()); value.update(id='unrelated-refreshed-video', words=123456)
            source.write_text(json.dumps(value)+'\n'); return self.completed(self.good())
        with patch.object(command.subprocess, 'run', side_effect=model): command.command_extract(args)
        report = json.loads((self.folder/'coverage.json').read_text())
        self.assertEqual(report['totals']['words'],8); self.assertEqual(report['totals']['mined_videos'],1)
        self.assertEqual(report['totals']['completed_videos'],1); self.assertEqual(report['totals']['rows'],1)
        self.assertEqual(len(report['row_files']),1)

    def test_boolean_and_number_content_do_not_merge(self):
        value = self.good(); content = json.loads(value['result']['choices'][0]['message']['content'])
        one = content['rows'][0]; one['custom'] = {'values':[True]}
        two = copy.deepcopy(one); two['custom'] = {'values':[1]}; content['rows'] = [one,two]
        value['result']['choices'][0]['message']['content'] = json.dumps(content)
        with patch.object(command.subprocess, 'run', return_value=self.completed(value)):
            result = command.command_extract(self.args())
        self.assertEqual(result['rows'],2)
        rows = [json.loads(line) for _,_,line in command.read_lines(str(self.folder/'out/Test.jsonl'))]
        self.assertIs(type(rows[0]['custom']['values'][0]), bool); self.assertIs(type(rows[1]['custom']['values'][0]), int)

    def test_kept_coverage_owns_source_citations_and_preserves_user_metadata_fields(self):
        value = self.good(); content = json.loads(value['result']['choices'][0]['message']['content'])
        content['rows'][0].update(failed_parts=12,error='custom',attempt={'custom':1},why='custom',row=['custom'],
                                  video={'custom':'data'},demonstrated_in=[['custom']])
        value['result']['choices'][0]['message']['content'] = json.dumps(content)
        args = self.args(); args.coverage_out = str(self.folder/'coverage.json')
        with patch.object(command.subprocess, 'run', return_value=self.completed(value)):
            command.command_extract(args)
        report = json.loads((self.folder/'coverage.json').read_text())
        self.assertEqual(report['totals']['rows'],1); self.assertEqual(len(report['row_files']),1)
        rows = self.folder/'generic.jsonl'; rows.write_text('{"video":[],"demonstrated_in":[[],false],"sources":[{"video":"v"}]}\n')
        result = command.command_coverage(argparse.Namespace(corpus=str(self.folder/'corpus.jsonl'),rows=[str(rows)],done=None,out=None))
        self.assertEqual(result['rows'],1)

    def test_packed_repeated_video_records_each_reply_and_drop_once(self):
        videos = self.folder/'order.txt'; videos.write_text('v\nv\n'); args = self.args(); args.videos = str(videos); args.chunk_words = 16
        asks = json.loads((self.folder/'asks.json').read_text()); asks['drop_when'] = {'kind':['drop']}; (self.folder/'asks.json').write_text(json.dumps(asks))
        value = self.good(); one = json.loads(value['result']['choices'][0]['message']['content'])['rows'][0]
        two = {**one,'part':2}; dropped = {**one,'kind':'drop'}
        value['result']['choices'][0]['message']['content'] = json.dumps({'rows':[one,two,dropped]})
        with patch.object(command.subprocess, 'run', return_value=self.completed(value)) as call:
            result = command.command_extract(args)
        self.assertEqual(call.call_count,1); self.assertEqual(result['rows'],1)
        done = command.read_done(str(self.folder/'out/done.jsonl'))['v']
        self.assertEqual(len(done['model_replies']),1); self.assertEqual(done['dropped'],1)


    def test_each_rows_contributing_model_list_is_independent(self):
        videos = self.folder/'order.txt'; videos.write_text('v\nv\n'); args = self.args(); args.videos = str(videos)
        first = self.good('route-a'); rows = json.loads(first['result']['choices'][0]['message']['content'])['rows']
        rows[0]['statement'] = 'First idea'; rows.append({**rows[0],'statement':'Second idea'})
        first['result']['choices'][0]['message']['content'] = json.dumps({'rows':rows})
        second = self.good('route-b'); second_rows = json.loads(second['result']['choices'][0]['message']['content'])['rows']
        second_rows[0]['statement'] = 'First idea'; second['result']['choices'][0]['message']['content'] = json.dumps({'rows':second_rows})
        with patch.object(command.subprocess, 'run', side_effect=[self.completed(first),self.completed(second)]):
            command.command_extract(args)
        kept = {row['statement']:row for row in (json.loads(line) for _,_,line in command.read_lines(str(self.folder/'out/Test.jsonl')))}
        self.assertEqual([m['served_by'] for m in kept['First idea']['extraction_models']], ['route-a','route-b'])
        self.assertEqual([m['served_by'] for m in kept['Second idea']['extraction_models']], ['route-a'])


if __name__ == '__main__':
    unittest.main()
