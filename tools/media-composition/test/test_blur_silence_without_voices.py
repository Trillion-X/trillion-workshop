"""With no agreed voices, blur-faces-not-agreed silences every stretch of speech and never loads the speaker model."""
import importlib.util
import pathlib
import types
import unittest
from unittest import mock

import numpy as np

DO_WORK = pathlib.Path(__file__).resolve().parent.parent / 'do-work'
SOURCE = DO_WORK / 'blur-faces-not-agreed.py'


def load_tool():
    spec = importlib.util.spec_from_file_location('blur_faces_not_agreed', SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SilenceWithoutVoicesTest(unittest.TestCase):
    def setUp(self):
        self.tool = load_tool()
        self.rate = 16000
        self.voices = types.SimpleNamespace(
            RATE=self.rate, FRAME=320, MODEL='/opt/models/campplus-voice/missing.onnx',
            audio_from=mock.Mock(return_value=np.zeros(self.rate * 4, dtype=np.int16)),
            embed=mock.Mock(), unit=mock.Mock())

    def test_every_speech_stretch_is_silenced_and_no_model_is_loaded(self):
        regions = [(0, 16000), (32000, 48000)]
        with mock.patch.object(self.tool, 'voices_module', return_value=self.voices), \
                mock.patch.object(self.tool, 'speech_regions', return_value=regions), \
                mock.patch.object(self.tool.ort, 'InferenceSession') as session:
            silenced, voices_used = self.tool.silenced_stretches('clip.mp4', [], 0.5)
        session.assert_not_called()
        self.voices.embed.assert_not_called()
        self.assertEqual(voices_used, 0)
        self.assertEqual(silenced, [(0.0, 1.0), (2.0, 3.0)])

    def test_no_speech_silences_nothing(self):
        with mock.patch.object(self.tool, 'voices_module', return_value=self.voices), \
                mock.patch.object(self.tool, 'speech_regions', return_value=[]), \
                mock.patch.object(self.tool.ort, 'InferenceSession') as session:
            silenced, voices_used = self.tool.silenced_stretches('clip.mp4', [], 0.5)
        session.assert_not_called()
        self.assertEqual((silenced, voices_used), ([], 0))


if __name__ == '__main__':
    unittest.main()
