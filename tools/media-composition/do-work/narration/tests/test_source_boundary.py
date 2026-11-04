"""Refusal/recovery regressions for the adopted source boundary; no synthesis."""
from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))
os.environ['SHOWTIME_SKILL'] = str(ROOT)


class SourceBoundary(unittest.TestCase):
    def test_installed_plugins_are_not_source(self):
        from st.voice import registry
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'SHOWTIME_ENGINE_PATH': directory}):
            (Path(directory) / 'unowned.py').write_text('raise RuntimeError("must never execute")')
            self.assertEqual(registry.search_dirs(), [ROOT / 'lib/st/voice/engines'])
            self.assertNotIn('unowned', registry.discover())
            self.assertIn('trillion_voice', registry.discover())

    def test_dependencies_never_install(self):
        from st import lazy
        from st.voice import models
        from st.common import ShowtimeError
        with self.assertRaisesRegex(ShowtimeError, 'cannot execute installer'):
            models._setup_module()
        with self.assertRaisesRegex(ShowtimeError, 'cannot download'):
            models._fetch('https://invalid.example/model', Path('unused'), None, None, 'unused')
        with patch.object(lazy, 'item_ready', return_value=False), self.assertRaisesRegex(ShowtimeError, 'cannot install'):
            lazy.ensure_item('missing-component', 'Narration')

    def test_only_narration_model_metadata_is_adopted(self):
        from st import lazy
        data = lazy.manifest()
        self.assertTrue(all(row.get('group') in ('voice', 'asr') for row in data['items']))
        self.assertEqual(set(data['lazy_pip']), {'whisper-engine'})

    def test_internal_identity_uses_existing_blake3_owner(self):
        from st.content_hash import content_hash
        h = content_hash(b'a')
        h.update(b'bc')
        self.assertEqual(h.hexdigest(), '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85')

    def test_exact_voice_aliases_are_refused_without_speaker_effect(self):
        from st.voice.engines.trillion_voice import ENGINE
        from st.voice.voices import VoiceSpec
        from st.common import ShowtimeError
        with self.assertRaisesRegex(ShowtimeError, 'exact existing'):
            ENGINE.synth([], VoiceSpec('trillion_voice', 'chosen', 'en'), 1, None)


if __name__ == '__main__':
    unittest.main()
