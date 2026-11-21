"""Tests of measure_prosody.py's pure parts with made-up audio written here: the level scaling, the frame levels, the pauses
and the speech edges, and the refusal of a silent clip. The F0 measure (librosa.pyin) and the speaker model are not run."""
import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'do-work'))
import measure_prosody as mp  # noqa: E402
import say_a_line_in_kokoro as kt  # noqa: E402

SR = 16000


def tone(seconds, level_db=-20.0):
    t = np.arange(int(seconds * SR)) / SR
    y = np.sin(2 * np.pi * 150 * t)
    return y * 10 ** (level_db / 20)


def clip(*parts):
    return np.concatenate(parts)


class Prosody(unittest.TestCase):
    def test_load_scales_the_ninetieth_percentile_frame_to_speech_level(self):
        y = clip(tone(1.0, -10.0), tone(1.0, -30.0))
        level = np.percentile(mp.frame_db(y), 90)
        scaled = y * 10 ** ((mp.SPEECH_DB - level) / 20)
        self.assertAlmostEqual(np.percentile(mp.frame_db(scaled), 90), mp.SPEECH_DB, places=3)

    def test_a_click_does_not_change_the_gain(self):
        speech = clip(tone(1.0, -30.0), np.zeros(SR // 10))
        clicked = speech.copy()
        clicked[SR // 2] = 0.9
        gain = lambda y: mp.SPEECH_DB - np.percentile(mp.frame_db(y), 90)
        self.assertAlmostEqual(gain(speech), gain(clicked), places=2)

    def test_a_pause_of_at_least_the_least_length_is_counted_with_its_length(self):
        db = np.array([-20.0] * 50 + [-60.0] * 30 + [-20.0] * 50)
        pauses, first, last = mp.pauses_and_speech(db, quiet_db=-45.0, least_s=0.12)
        self.assertEqual(first, 0)
        self.assertEqual(last, 129)
        self.assertEqual(pauses, [{'at_s': 0.5, 's': 0.3}])

    def test_a_short_gap_is_not_a_pause(self):
        db = np.array([-20.0] * 50 + [-60.0] * 5 + [-20.0] * 50)
        pauses, _, _ = mp.pauses_and_speech(db, quiet_db=-45.0, least_s=0.12)
        self.assertEqual(pauses, [])

    def test_a_silent_clip_is_refused(self):
        with self.assertRaises(kt.Refusal):
            mp.pauses_and_speech(np.full(100, -80.0))


if __name__ == '__main__':
    unittest.main()
