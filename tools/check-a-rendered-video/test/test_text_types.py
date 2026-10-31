"""box_j and box_k: their text blocks are read from timeline.json (text contrast), and a typed card of several lines is followed line by line
(type-sync, speed key chars_per_s). Run: python3 test/run_tests.py"""
import os
import sys
import unittest
import wave

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import Base, FPS, ctx_for, limits, write_overlay, write_video  # noqa: E402
from rendercheck.checks import text, type_sync  # noqa: E402
from rendercheck.report import verdict  # noqa: E402


class KineticContrast(Base):
    def ctx(self, colour, boxes):
        n = int(FPS * 2.0)
        write_video(self.path('p.mp4'), [np.full((1080, 1920, 3), 40, np.uint8)] * n)
        fr = np.zeros((1080, 1920, 4), np.uint8)
        fr[300:400, 200:700] = (*colour, 255)
        write_overlay(self.path('o.mov'), [fr] * n)
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 2.0]}, 'events': [{'type': 'box_j', 'id': 'q', 'text': 'Can the food you love', 'times': [0, 0, 0, 0, 0], 'out': 5}]}
        ctx = ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))
        ctx.timeline = {'boxes': boxes}
        return ctx

    BOX = [{'id': 'q', 't0': 0.0, 'box': [210, 310, 690, 390]}]

    def test_the_string_is_linted_and_the_block_is_read_from_the_timeline(self):
        for kind in ('box_j', 'box_k'):
            self.assertIn(kind, limits()['text']['fields'])
            self.assertIn(kind, limits()['text']['timeline_box_types'])
        self.assertEqual(len(text.strings(self.ctx((255, 255, 255), self.BOX))), 1)
        self.assertEqual(len(text._direct_boxes(self.ctx((255, 255, 255), self.BOX))), 1)

    def test_white_words_on_dark_footage_pass_and_black_fail(self):
        ok = text.rendered_findings(self.ctx((255, 255, 255), self.BOX))
        self.assertEqual([f for f in ok if f.status == 'FAIL'], [])
        bad = text.rendered_findings(self.ctx((0, 0, 0), self.BOX))
        self.assertTrue(any('contrast' in f.message and 'box_j "q"' in f.message for f in bad))

    def contrast_times(self, boxes):
        return [t for f in text.rendered_findings(self.ctx((0, 0, 0), boxes)) if 'contrast' in f.message for t in (f.t, f.t_end) if t is not None]

    def test_a_box_owns_text_only_while_its_event_is_on_screen(self):
        gone = self.contrast_times([{'id': 'q', 't0': 0.0, 't1': 0.5, 'box': [210, 310, 690, 390]}])
        self.assertTrue(gone)
        self.assertTrue(all(t <= 0.5 + 1e-6 for t in gone), gone)
        self.assertEqual(self.contrast_times([{'id': 'q', 't0': 5.0, 't1': 6.0, 'box': [210, 310, 690, 390]}]), [])

    def test_a_box_with_no_end_stays_until_the_next_box_of_its_id_or_the_end_of_the_video(self):
        replaced = self.contrast_times([{'id': 'q', 't0': 0.0, 'box': [210, 310, 690, 390]}, {'id': 'q', 't0': 1.0, 'box': [1200, 100, 1500, 160]}])
        self.assertTrue(replaced)
        self.assertTrue(all(t <= 1.0 + 1e-6 for t in replaced), replaced)
        alone = self.contrast_times([{'id': 'q', 't0': 0.0, 'box': [210, 310, 690, 390]}])
        self.assertGreaterEqual(max(alone), 1.5)
        self.assertEqual(text._box_spans(self.ctx((0, 0, 0), self.BOX), 'q')[0][1:], (0.0, None))

    def test_no_recorded_box_means_nothing_is_measured_not_a_pass_by_guess(self):
        c = self.ctx((0, 0, 0), [])
        self.assertEqual(text._direct_boxes(c), [])
        self.assertFalse(any('contrast' in f.message for f in text.rendered_findings(c)))


class MultiLineTyping(Base):
    TEXT = 'abcd\nefgh\nijkl'

    def ctx(self, silent_line=None):
        n = int(FPS * 3.0)
        frames = []
        for i in range(n):
            fr = np.zeros((180, 320, 4), np.uint8)
            if i >= 3:
                fr[0:90, 0:140] = (240, 235, 220, 255)      # the scrap lands
                for k in range(12):
                    if i >= 6 + 2 * k + 2 * (k // 4):        # a letter every other frame, one extra beat at each line break
                        row, col = divmod(k, 4)
                        fr[row * 30 + 8:row * 30 + 22, 8 + col * 12:8 + col * 12 + 6] = (20, 20, 20, 255)
            frames.append(fr)
        write_overlay(self.path('overlay.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((180, 320, 3), 40, np.uint8)] * n)
        sr = 16000
        audio = np.zeros(sr * 3)
        for k in range(12):
            if k // 4 == silent_line:
                continue
            at = (6 + 2 * k + 2 * (k // 4)) / FPS
            audio[int(at * sr):int(at * sr) + 80] = 0.06 * np.hanning(80)
        with wave.open(self.path('sfx-only.wav'), 'wb') as f:
            f.setnchannels(1)
            f.setsampwidth(2)
            f.setframerate(sr)
            f.writeframes((audio * 32767).astype(np.int16).tobytes())
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 3.0]},
                'events': [{'type': 'box_k', 'id': 't', 'text': self.TEXT, 'size': 10, 'pos': [8, 12], 'chars_per_s': 12, 'typing': True, 'at': 0.1}]}
        ctx = ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('overlay.mov'))
        ctx.timeline = {'boxes': [{'id': 't', 't0': 0.1, 'box': [0, 0, 140, 90]}]}
        return ctx

    def test_chars_per_s_declares_the_typing_and_every_line_is_followed(self):
        c = self.ctx()
        self.assertEqual(len(type_sync.type_on_events(c)), 1)
        self.assertEqual(type_sync.undeclared_typing(c), [])
        fs = type_sync.run(c)
        self.assertEqual(verdict(fs), 'PASS', [f.message for f in fs])
        self.assertIn('12 characters', fs[-1].message)

    def test_a_line_with_no_key_sounds_fails_and_names_its_letters(self):
        fs = type_sync.run(self.ctx(silent_line=1))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertTrue(any('"efgh"' in f.message for f in fs if f.status == 'FAIL'), [f.message for f in fs])


if __name__ == '__main__':
    unittest.main()
