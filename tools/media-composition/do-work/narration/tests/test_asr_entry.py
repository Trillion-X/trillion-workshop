"""Read-only ASR admission and recovery; models/recognition are mocked here."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('owned_narration_entry', ROOT / 'produce.py')
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)


class AsrEntryTests(unittest.TestCase):
    def test_existing_voice_command_and_new_inspection_parse(self):
        parsed = entry.build_parser().parse_args(['voice', 'script', 'input.json', '-o', 'output'])
        self.assertEqual((parsed.command, parsed.operation, parsed.input, parsed.output), ('voice', 'script', 'input.json', 'output'))
        parsed = entry.build_parser().parse_args(['asr', 'inspect', '--lang', 'en'])
        self.assertEqual((parsed.command, parsed.operation, parsed.lang), ('asr', 'inspect', 'en'))

    def test_readiness_refuses_missing_model_python_or_component_and_retains_errors(self):
        from st import lazy
        from st.footage import transcribe
        with patch.object(transcribe, '_installed', return_value=True), \
             patch.object(lazy, 'pip_ready', return_value=True), patch.object(lazy, 'item_ready', return_value=True), \
             patch.object(lazy, 'ensure_item', side_effect=AssertionError('must not install')), \
             patch.object(lazy, 'ensure_pip', side_effect=AssertionError('must not install')):
            self.assertEqual(entry.model_readiness('whisper', 'small.en')['state'], 'ready_candidate')
            with patch.object(transcribe, '_installed', return_value=False):
                self.assertEqual(entry.model_readiness('whisper', 'small.en')['state'], 'unavailable')
            with patch.object(lazy, 'pip_ready', return_value=False):
                self.assertEqual(entry.model_readiness('whisper', 'small.en')['state'], 'unavailable')
            with patch.object(lazy, 'item_ready', return_value=False):
                self.assertEqual(entry.model_readiness('whisper', 'small.en')['state'], 'unavailable')
            with patch.object(lazy, 'manifest', side_effect=OSError('unreadable metadata')):
                result = entry.model_readiness('whisper', 'small.en')
                self.assertEqual(result['state'], 'unknown')
                self.assertIn('unreadable', result['reason'])
        self.assertEqual(entry.model_readiness('undeclared-engine', 'any')['state'], 'unsupported')

    def test_inspection_groups_actual_aliases_without_loading_or_installing(self):
        from st.footage import transcribe
        from st.voice import readback
        models = {'first': ('whisper', 'one'), 'first-alias': ('whisper', 'one'), 'second': ('whisper', 'two')}
        choose = lambda alias, language: models['first' if alias == 'auto' else alias]
        with patch.dict(transcribe.MODELS, models, clear=True), patch.object(transcribe, 'choose_model', side_effect=choose), \
             patch.object(entry, 'model_readiness', return_value={'state': 'ready_candidate'}), \
             patch.object(readback, 'second_recognizer', return_value={'model': 'second', 'label': 'second model'}), \
             patch.object(transcribe, 'transcribe', side_effect=AssertionError('must not recognize')):
            result = entry.inspect_asr('en')
        self.assertEqual(len(result['models']), 2)
        self.assertEqual(result['models'][0]['aliases'], ['first', 'first-alias'])
        self.assertTrue(result['models'][0]['same_as_current_primary'])
        self.assertFalse(result['models'][1]['same_as_current_primary'])
        self.assertFalse(result['model_loading'])
        self.assertFalse(result['downloads'])

    def fixture(self, folder):
        source = folder / 'voice'
        source.mkdir()
        (source / 'lines').mkdir()
        lines = []
        for index, name in enumerate(['one', 'two', 'three'], 1):
            clip = 'lines/' + name + '.wav'
            (source / clip).write_bytes(('unaltered audio ' + name).encode())
            lines.append({'index': index, 'id': name, 'text': 'Source ' + name + '.', 'file': clip})
        (source / 'vo.wav').write_bytes(b'whole unchanged waveform')
        (source / 'readback.json').write_text('{"suspects":[]}')
        (source / 'timeline.json').write_text(json.dumps({'file': 'vo.wav', 'readback': {'file': 'readback.json'}, 'lines': lines}))
        return source

    def test_selected_lines_only_bind_unchanged_sources_and_refuse_stale_or_reused_output(self):
        from st.footage import transcribe
        calls = []
        def hear(path, **options):
            calls.append((Path(path).name, options))
            document = {'text': 'Heard words.', 'model': 'fixture-model', 'engine': 'fixture-engine',
                        'words': [{'type': 'word', 'text': 'Heard', 'start': 0, 'end': .2}], 'guards': {}}
            options['out_path'].write_text(json.dumps(document))
            return document, options['out_path']
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); source = self.fixture(folder); output = folder / 'evidence'
            before = {str(path): path.read_bytes() for path in source.rglob('*') if path.is_file()}
            with patch.object(entry, 'model_readiness', return_value={'state': 'ready_candidate'}), \
                 patch.object(transcribe, 'transcribe', side_effect=hear):
                result = entry.recheck_lines(source, 'small.en', ['three', 'one'], output)
                self.assertEqual([line['id'] for line in result['lines']], ['one', 'three'])
                self.assertEqual([name for name, _ in calls], ['one.wav', 'three.wav'])
                self.assertTrue(all(options['force'] and options['prompt'] == '' and not options['use_stem'] for _, options in calls))
                self.assertTrue(all(Path(path).read_bytes() == value for path, value in before.items()))
                self.assertEqual(json.loads((output / 'source-binding.json').read_text())['state'], 'recognized_bound')
                with self.assertRaises(FileExistsError):
                    entry.recheck_lines(source, 'small.en', ['one'], output)
                with self.assertRaisesRegex(Exception, 'unique'):
                    entry.recheck_lines(source, 'small.en', ['one', 'one'], folder / 'duplicates')
                with self.assertRaisesRegex(Exception, 'absent'):
                    entry.recheck_lines(source, 'small.en', ['missing'], folder / 'missing')
                changed = json.loads((source / 'timeline.json').read_text())
                changed['lines'][0]['file'] = '../outside.wav'
                (source / 'timeline.json').write_text(json.dumps(changed))
                before_calls = len(calls)
                with self.assertRaisesRegex(Exception, 'leaves its voice directory'):
                    entry.recheck_lines(source, 'small.en', ['one'], folder / 'escape')
                self.assertEqual(len(calls), before_calls)
                (source / 'timeline.json').write_bytes(before[str(source / 'timeline.json')])
                def change_source(path, **options):
                    document, target = hear(path, **options)
                    (source / 'vo.wav').write_bytes(b'changed during recognition')
                    return document, target
                with patch.object(transcribe, 'transcribe', side_effect=change_source), self.assertRaisesRegex(Exception, 'changed during recognition'):
                    entry.recheck_lines(source, 'small.en', ['one'], folder / 'stale')
                self.assertEqual(json.loads((folder / 'stale/source-binding.json').read_text())['state'], 'recognition_failed')

    def test_unready_model_never_recognizes_and_failed_epoch_recovers_only_in_fresh_output(self):
        from st.footage import transcribe
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); source = self.fixture(folder); failed = folder / 'failed'
            with patch.object(entry, 'model_readiness', return_value={'state': 'unavailable'}), \
                 patch.object(transcribe, 'transcribe') as hear:
                with self.assertRaisesRegex(Exception, 'explicit model alias'):
                    entry.recheck_lines(source, '/outside/undeclared-weights', ['one'], failed)
                with self.assertRaisesRegex(Exception, 'not ready'):
                    entry.recheck_lines(source, 'small.en', ['one'], failed)
                hear.assert_not_called()
                self.assertFalse(failed.exists())
            with patch.object(entry, 'model_readiness', return_value={'state': 'ready_candidate'}), \
                 patch.object(transcribe, 'transcribe', side_effect=RuntimeError('recognizer failed')):
                with self.assertRaisesRegex(RuntimeError, 'recognizer failed'):
                    entry.recheck_lines(source, 'small.en', ['one'], failed)
            self.assertEqual(json.loads((failed / 'source-binding.json').read_text())['state'], 'recognition_failed')
            def recovered(path, **options):
                document = {'text': 'Source one.', 'model': 'local', 'engine': 'local', 'words': [], 'guards': {}}
                options['out_path'].write_text(json.dumps(document)); return document, options['out_path']
            with patch.object(entry, 'model_readiness', return_value={'state': 'ready_candidate'}), \
                 patch.object(transcribe, 'transcribe', side_effect=recovered):
                with self.assertRaises(FileExistsError):
                    entry.recheck_lines(source, 'small.en', ['one'], failed)
                result = entry.recheck_lines(source, 'small.en', ['one'], folder / 'recovered')
                self.assertTrue(result['source_inputs_unchanged'])


if __name__ == '__main__':
    unittest.main()
