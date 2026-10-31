"""One passing and one failing case per check, on synthetic media made with ffmpeg. Run: python3 test/run_tests.py"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import wave

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
from rendercheck import config, jsonio  # noqa: E402
from rendercheck.ctx import Context  # noqa: E402
from rendercheck.checks import backing, movement, dwell, type_sync, exits, face, in_frame, jitter, joins, text, word_clip  # noqa: E402
from rendercheck.report import verdict  # noqa: E402

FPS = 24
LIMITS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'limits-for-generated-videos.json')


def limits():
    """The limits the generated videos are checked against: a synthetic file kept beside the tests."""
    return config.load(LIMITS)


def write_video(path, frames, pix_in='rgb24', codec=('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12')):
    h, w = frames[0].shape[:2]
    p = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', pix_in, '-s', f'{w}x{h}', '-r', str(FPS),
                          '-i', '-', *codec, path], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(np.ascontiguousarray(f).tobytes())
    p.stdin.close()
    assert p.wait() == 0


def write_overlay(path, frames_rgba):
    write_video(path, frames_rgba, 'rgba', ('-c:v', 'qtrle', '-pix_fmt', 'argb'))


def add_audio(video, samples, sr=16000):
    wav = video + '.wav'
    with wave.open(wav, 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
    out = video + '.mux.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', video, '-i', wav, '-c:v', 'copy', '-c:a', 'aac', '-shortest', out], check=True)
    os.replace(out, video)


def moving(n, w=192, h=108, seed=1):
    """Footage that always moves a little: a gradient that drifts plus fixed noise."""
    rng = np.random.default_rng(seed)
    noise = rng.integers(0, 12, (h, w, 1))
    xs = np.linspace(0, 1, w)[None, :, None]
    out = []
    for i in range(n):
        v = ((xs * 180 + i * 6) % 255 + noise).clip(0, 255)
        out.append(np.repeat(v, h, axis=0).repeat(3, axis=2).astype(np.uint8))
    return out


def ctx_for(tmp, preview, spec, **kw):
    return Context(preview, spec, limits(), **kw)


class Base(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.tmp = self._t.name

    def tearDown(self):
        self._t.cleanup()

    def path(self, name):
        return os.path.join(self.tmp, name)


class InFrame(Base):
    def overlay(self, x0, x1, seconds=2.0):
        n = int(FPS * seconds)
        fr = np.zeros((90, 160, 4), np.uint8)
        fr[30:60, x0:x1] = (255, 255, 255, 255)
        write_overlay(self.path('overlay.mov'), [fr] * n)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, seconds]}, 'events': []}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('overlay.mov'))

    def test_card_inside_the_safe_area_passes(self):
        self.assertEqual(verdict(in_frame.run(self.overlay(40, 110))), 'PASS')

    def test_card_running_off_the_right_edge_fails(self):
        fs = in_frame.run(self.overlay(100, 160))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('right frame edge', fs[0].message)

    def test_deliberately_off_frame_element_is_not_a_failure(self):
        ctx = self.overlay(100, 160)
        ctx.spec['events'] = [{'type': 'box_d', 'id': 's', 'pos': [1500, 400], 'off_frame': True, 'at': 0}]
        self.assertNotEqual(verdict(in_frame.run(ctx)), 'FAIL')

    def test_spec_box_past_the_frame_fails_and_inside_passes(self):
        ctx = self.overlay(40, 110)
        ctx.spec['events'] = [{'type': 'box_a', 'id': 't', 'pos': [1873, 450], 'size': 104, 'at': 0}]
        self.assertEqual(verdict(in_frame.spec_findings(ctx)), 'FAIL')
        ctx.spec['events'] = [{'type': 'box_a', 'id': 't', 'pos': [1500, 450], 'size': 104, 'at': 0}]
        self.assertEqual(in_frame.spec_findings(ctx), [])


class Joins(Base):
    def run_joins(self, frames, spec):
        write_video(self.path('p.mp4'), frames)
        return joins.run(ctx_for(self.tmp, self.path('p.mp4'), spec))

    def test_clean_footage_passes(self):
        self.assertEqual(verdict(self.run_joins(moving(60), {'edit': {'preview': [0, 2.5]}})), 'PASS')

    def test_one_out_of_sequence_frame_fails(self):
        fr = moving(60)
        fr[30] = 255 - fr[30]
        fs = self.run_joins(fr, {'edit': {'preview': [0, 2.5]}})
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('out-of-sequence', fs[0].message)

    def test_hold_that_resumes_on_a_different_frame_fails(self):
        base = moving(80)
        fr = base[:20] + [base[19]] * 24 + [255 - f for f in base[60:76]]  # hold of frame 19, then different footage
        spec = {'edit': {'preview': [0, 60 / FPS], 'hold': {'at': 20 / FPS, 'seconds': 1.0}}}
        self.assertEqual(verdict(self.run_joins(fr, spec)), 'FAIL')

    def test_declared_cover_over_the_hold_exit_is_not_judged_but_an_undeclared_one_fails(self):
        base = moving(80)
        fr = base[:20] + [base[19]] * 24 + [255 - f for f in base[60:76]]
        edit = {'preview': [0, 60 / FPS], 'hold': {'at': 20 / FPS, 'seconds': 1.0}, 'overlay': {'at': 0}}
        cover = {'type': 'cover_c', 'at': 0.0, 'covers_a_roll': True, 'until': 44 / FPS}        # a cover fills the frame until the exit
        self.assertNotEqual(verdict(self.run_joins(fr, {'edit': edit, 'events': [cover]})), 'FAIL')
        self.assertEqual(verdict(self.run_joins(fr, {'edit': edit, 'events': [dict(cover, covers_a_roll=False)]})), 'FAIL')
        early = dict(cover, until=10 / FPS)                                                          # a cover that ends long before the exit hides nothing there
        self.assertEqual(verdict(self.run_joins(fr, {'edit': edit, 'events': [early]})), 'FAIL')

    def test_hold_that_resumes_on_the_held_frame_passes(self):
        base = moving(80)
        fr = base[:20] + [base[19]] * 24 + base[20:36]
        spec = {'edit': {'preview': [0, 60 / FPS], 'hold': {'at': 20 / FPS, 'seconds': 1.0}}}
        self.assertEqual(verdict(self.run_joins(fr, spec)), 'PASS')


class WordClip(Base):
    def video_with_tone(self, stop_at, fade):
        sr = 16000
        t = np.arange(int(3 * sr)) / sr
        tone = 0.3 * np.sin(2 * np.pi * 220 * t) * (t < stop_at)
        if fade:
            ramp = np.clip((stop_at - t) / 0.12, 0, 1)
            tone = 0.3 * np.sin(2 * np.pi * 220 * t) * ramp * (t < stop_at)
        write_video(self.path('p.mp4'), moving(72))
        add_audio(self.path('p.mp4'), tone)
        jsonio.write(self.path('w.json'), [])
        spec = {'edit': {'preview': [0, 3.0], 'hold': {'at': 1.0, 'seconds': 1.0}}}
        return Context(self.path('p.mp4'), spec, limits(), words=self.path('w.json'))

    def test_audio_that_stops_before_the_join_passes(self):
        fs = word_clip.run(self.video_with_tone(stop_at=0.8, fade=True))
        self.assertNotEqual(verdict(fs), 'FAIL')

    def test_audio_chopped_mid_sound_at_the_join_fails(self):
        fs = word_clip.run(self.video_with_tone(stop_at=1.0, fade=False))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertTrue(any('stops abruptly' in f.message for f in fs if f.status == 'FAIL'))

    def test_source_footage_word_timings_flag_a_cut_inside_a_word(self):
        ctx = self.video_with_tone(stop_at=0.8, fade=True)
        ctx.source_words = [{'w': 'humanity', 's': 0.7, 'e': 1.3}]
        self.assertTrue(any('inside the word "humanity"' in f.message for f in word_clip.run(ctx)))
        ctx.source_words = [{'w': 'humanity', 's': 0.3, 'e': 0.8}]
        self.assertFalse(any('inside the word' in f.message for f in word_clip.run(ctx)))


class Jitter(Base):
    def ctx(self, events):
        write_video(self.path('p.mp4'), moving(24))
        return ctx_for(self.tmp, self.path('p.mp4'), {'duration_s': 30.0, 'edit': {'preview': [0, 1]}, 'events': events})

    def test_two_still_prints_pass(self):
        ev = [{'type': 'box_b', 'id': f'p{i}', 'at': 1.0 * i, 'jitter': False} for i in range(2)]
        self.assertEqual(verdict(jitter.run(self.ctx(ev))), 'PASS')

    def test_six_cards_shaking_for_half_a_minute_fail(self):
        ev = [{'type': 'box_b', 'id': f'p{i}', 'at': float(i)} for i in range(6)]
        fs = jitter.run(self.ctx(ev))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertTrue(any('budget' in f.message for f in fs))

    def test_jitter_s_makes_a_short_shake_count_as_short(self):
        long_ = [{'type': 'box_b', 'id': f'p{i}', 'at': 0.0} for i in range(3)]
        self.assertEqual(verdict(jitter.run(self.ctx(long_))), 'FAIL')
        short = [dict(e, jitter_s=1.0) for e in long_]
        self.assertNotEqual(verdict(jitter.run(self.ctx(short))), 'FAIL')

    def test_a_slow_drift_is_not_in_the_budget_but_a_fast_one_is(self):
        slow = [{'type': 'box_b', 'id': f'p{i}', 'at': 0.0, 'jitter': False, 'drift': {'px': 8, 'period_s': 6.0}} for i in range(6)]
        self.assertEqual(verdict(jitter.run(self.ctx(slow))), 'PASS')
        fast = [dict(e, drift={'px': 8, 'period_s': 1.0}) for e in slow]                  # about 50 px/s at its fastest
        self.assertEqual(verdict(jitter.run(self.ctx(fast))), 'FAIL')

    def test_a_short_jitter_passes(self):
        ev = [{'type': 'box_a', 'id': 't', 'at': 0.0}, {'type': 'slide_out', 'targets': ['t'], 'at': 3.0}]
        self.assertEqual(verdict(jitter.run(self.ctx(ev))), 'PASS')


class TextLint(Base):
    def ctx(self, events, overlay=None, footage=40, seconds=2.0, size=(1080, 1920)):
        n = int(FPS * seconds)
        write_video(self.path('p.mp4'), [np.full((*size, 3), footage, np.uint8)] * n)
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, seconds]}, 'events': events}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=overlay)

    def overlay(self, colour, y0=300, border=None):
        fr = np.zeros((1080, 1920, 4), np.uint8)
        fr[y0:y0 + 100, 200:700] = (*colour, 255)
        if border:
            inner = fr[y0 + 8:y0 + 92, 208:692].copy()
            fr[y0:y0 + 100, 200:700] = (*border, 255)
            fr[y0 + 8:y0 + 92, 208:692] = inner
        write_overlay(self.path('o.mov'), [fr] * int(FPS * 2.0))
        return self.path('o.mov')

    WORD = {'type': 'words_q', 'id': 'w', 'text': 'high protein', 'size': 90, 'pos': [210, 290], 'at': 0.0}

    def test_finished_phrase_passes_and_trailing_comma_fails(self):
        self.assertEqual(verdict(text.lint_strings(self.ctx([{**self.WORD, 'text': 'low calorie'}]))), 'PASS')
        fs = text.lint_strings(self.ctx([{**self.WORD, 'text': 'short phrase,'}]))
        self.assertEqual(verdict(fs), 'FAIL')

    def test_box_c_is_linted_with_its_typed_continuation(self):
        ev = {'type': 'box_c', 'id': 'q', 'text': 'What does the most reliable plan', 'then': {'text': 'look like?'}, 'at': 0}
        self.assertEqual(text.lint_strings(self.ctx([ev])), [])

    def test_text_that_ends_on_a_dangling_word_fails(self):
        fs = text.lint_strings(self.ctx([{**self.WORD, 'text': 'protein and'}]))
        self.assertEqual(verdict(fs), 'FAIL')

    def test_white_text_on_dark_footage_passes_and_black_fails(self):
        ok = text.rendered_findings(self.ctx([self.WORD], self.overlay((255, 255, 255))))
        self.assertEqual([f for f in ok if f.status == 'FAIL'], [])
        bad = text.rendered_findings(self.ctx([self.WORD], self.overlay((0, 0, 0))))
        self.assertTrue(any('contrast' in f.message for f in bad))

    def test_rolling_text_is_measured_on_settled_frames_only(self):
        rolling = dict(self.WORD, rolling=True, settle_s=5.0)
        bad = text.rendered_findings(self.ctx([rolling], self.overlay((0, 0, 0))))
        self.assertFalse(any('contrast' in f.message for f in bad), 'whole clip is before the settle time')
        settled = dict(self.WORD, rolling=True, settle_s=0.2)
        bad = text.rendered_findings(self.ctx([settled], self.overlay((0, 0, 0))))
        self.assertTrue(any('contrast' in f.message for f in bad))

    def test_settle_is_measured_from_the_overlay_start_not_the_preview_clock(self):
        n = int(FPS * 6.0)
        write_video(self.path('p.mp4'), [np.full((270, 480, 3), 40, np.uint8)] * n)
        fr = np.zeros((1080, 1920, 4), np.uint8)
        fr[300:400, 200:700] = (0, 0, 0, 255)
        write_overlay(self.path('o.mov'), [fr] * int(FPS * 2.0))
        word = dict(self.WORD, rolling=True, settle_s=3.5, at=0.0)
        spec = {'edit': {'overlay': {'at': 4.0}, 'preview': [0, 6.0]}, 'events': [word]}      # overlay starts at preview 4.0 s
        ctx = ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))
        self.assertFalse(any('contrast' in f.message for f in text.rendered_findings(ctx)), 'the 2 s overlay is all before the 3.5 s settle')
        word['settle_s'] = 0.5
        self.assertTrue(any('contrast' in f.message for f in text.rendered_findings(ctx)))

    def test_overlapping_boxes_give_the_text_to_the_nearest_element(self):
        far = dict(self.WORD, id='far', pos=[210, 290])
        near = dict(self.WORD, id='near', pos=[210, 400])
        fs = text.rendered_findings(self.ctx([far, near], self.overlay((0, 0, 0), y0=400)))
        bad = [f for f in fs if 'contrast' in f.message]
        self.assertTrue(bad)
        self.assertTrue(all('"near"' in f.message for f in bad), [f.message for f in bad])

    def test_element_types_are_linted_from_the_canonical_config(self):
        cfg = limits()
        for kind in ('box_c2', 'box_i', 'box_f', 'box_e2', 'box_d2', 'box_h2', 'box_o', 'box_g2'):
            self.assertIn(kind, cfg['text']['fields'])
        self.assertIn('box_h2', cfg['text']['direct_over_footage_types'])
        ctx = ctx_for(self.tmp, self.path('p.mp4') if os.path.exists(self.path('p.mp4')) else self._video(), {'events': [
            {'type': 'box_c2', 'id': 'q', 'text': 'what does it look like,', 'at': 0.1}]})
        self.assertTrue(any('ends with' in f.message for f in text.lint_strings(ctx) if f.status == 'FAIL'))

    def _video(self):
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * FPS)
        return self.path('p.mp4')

    def test_outlined_text_fails(self):
        fs = text.rendered_findings(self.ctx([self.WORD], self.overlay((255, 255, 255), border=(0, 0, 0))))
        self.assertTrue(any('outline' in f.message for f in fs))

    def test_text_in_the_bottom_caption_zone_fails_and_mid_frame_passes(self):
        low = text.rendered_findings(self.ctx([], self.overlay((255, 255, 255), y0=960)))
        self.assertTrue(any('bottom' in f.message for f in low))
        mid = text.rendered_findings(self.ctx([], self.overlay((255, 255, 255), y0=400)))
        self.assertFalse(any('bottom' in f.message for f in mid))

    def test_spec_outline_key_fails(self):
        fs = text.lint_strings(self.ctx([{**self.WORD, 'stroke': 3}]))
        self.assertEqual(verdict(fs), 'FAIL')


class Face(Base):
    def ctx(self, x0, x1):
        n = FPS * 3
        fr = np.zeros((90, 160, 4), np.uint8)
        fr[10:80, x0:x1] = (255, 255, 255, 255)
        write_overlay(self.path('o.mov'), [fr] * n)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 3.0]}, 'events': []}
        face.detect = lambda gray: [(280, 90, 80, 100)]          # a face at x 0.44-0.56, y 0.25-0.53 of the frame
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))

    def test_overlay_over_the_face_fails_and_beside_it_passes(self):
        self.assertEqual(verdict(face.run(self.ctx(60, 110))), 'FAIL')
        self.assertEqual(verdict(face.run(self.ctx(0, 40))), 'PASS')

    def full_frame_ctx(self, flagged):
        n = FPS * 3
        fr = np.full((90, 160, 4), 255, np.uint8)
        write_overlay(self.path('o.mov'), [fr] * n)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        ev = {'type': 'overlay_b2', 'id': 'b', 'at': 0.0, 'out': 3.0}
        if flagged:
            ev['covers_a_roll'] = True
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 3.0]}, 'events': [ev]}
        face.detect = lambda gray: [(280, 90, 80, 100)]
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))

    def test_declared_exit_window_of_a_cutaway_is_exempt_and_undeclared_is_not(self):
        n = FPS * 3
        frames = []
        for i in range(n):
            fr = np.zeros((90, 160, 4), np.uint8)
            if i < FPS * 2:
                fr[:, :] = (255, 255, 255, 255)                          # full-frame cutaway until 2.0 s
            elif i < int(FPS * 2.6):
                fr[10:80, 60:110] = (255, 255, 255, 255)                 # exit: it shrinks over the face for 0.6 s
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        face.detect = lambda gray: [(280, 90, 80, 100)]
        for declared, expected in ((True, 'PASS'), (False, 'FAIL')):
            ev = {'type': 'overlay_b2', 'id': 'b', 'at': 0.0, 'out': 2.7, 'covers_a_roll': True}
            if declared:
                ev['exit_s'] = 0.7
            spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 3.0]}, 'events': [ev]}
            self.assertEqual(verdict(face.run(ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov')))), expected, declared)

    def test_declared_full_frame_cutaway_hides_the_face_so_it_is_not_a_fail(self):
        self.assertEqual(verdict(face.run(self.full_frame_ctx(True))), 'PASS')

    def test_the_same_full_frame_overlay_without_the_declaration_still_fails(self):
        self.assertEqual(verdict(face.run(self.full_frame_ctx(False))), 'FAIL')

    def test_no_face_found_is_reported_not_passed_silently(self):
        ctx = self.ctx(60, 110)
        face.detect = lambda gray: []
        fs = face.run(ctx)
        self.assertTrue(any('not measured' in f.message for f in fs))


class Exits(Base):
    def ctx(self, vanish_at_edge):
        n = FPS * 2
        frames = []
        for i in range(n):
            fr = np.zeros((90, 160, 4), np.uint8)
            x = 10 + i * 4
            if vanish_at_edge:
                if x + 30 <= 160 + 30 and i < 38:
                    fr[30:60, x:min(160, x + 30)] = (255, 255, 255, 255)
            elif i < 20:
                fr[30:60, x:x + 30] = (255, 255, 255, 255)
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 2.0]}, 'events': []}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))

    def test_element_that_slides_out_of_the_frame_passes(self):
        self.assertEqual(verdict(exits.run(self.ctx(True))), 'PASS')

    def test_moving_element_that_vanishes_mid_frame_fails(self):
        fs = exits.run(self.ctx(False))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertTrue(any('vanishes' in f.message for f in fs))


class ExitsErase(Base):
    def ctx(self, shrink):
        n = FPS * 2
        frames = []
        for i in range(n):
            fr = np.zeros((90, 160, 4), np.uint8)
            if i < 20:
                if shrink:      # a stroke wiped from the right: the same left edge, the centre drifts left as pixels go
                    fr[30:60, 20:max(21, 80 - i * 3)] = (255, 255, 255, 255)
                    if i >= 18:
                        fr[30:60, 20:24] = (255, 255, 255, 255)
                        fr[30:60, 24:80 - 19 * 3 + 0] = 0
                else:
                    fr[30:60, 10 + i * 4:40 + i * 4] = (255, 255, 255, 255)
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': 0}, 'preview': [0, 2.0]}, 'events': []}, overlay=self.path('o.mov'))

    def test_a_stroke_erasing_in_place_passes_and_a_vanishing_mover_still_fails(self):
        self.assertEqual(verdict(exits.run(self.ctx(True))), 'PASS')
        self.assertEqual(verdict(exits.run(self.ctx(False))), 'FAIL')


class ExitsMasked(Base):
    def ctx(self, masked):
        n = FPS * 2
        frames = []
        for i in range(n):
            fr = np.zeros((90, 160, 4), np.uint8)
            if i < 20:
                fr[30:60, 10 + i * 4:40 + i * 4] = (255, 255, 255, 255)     # a mover that stops existing mid-frame
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        events = [{'type': 'odometer', 'id': 'odo', 'at': 0.0, 'window': [0, 270, 1920, 720]},
                  {'type': 'digit', 'id': 'd1', 'at': 0.0, 'masked_within': 'odo' if masked else 'nothing'}]
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 2.0]}, 'events': events}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))

    def test_child_inside_a_declared_window_is_not_an_exit_and_without_it_fails(self):
        self.assertEqual(verdict(exits.run(self.ctx(True))), 'PASS')
        self.assertEqual(verdict(exits.run(self.ctx(False))), 'FAIL')


class Dwell(Base):
    def ctx(self, on_frames, text_words):
        n = FPS * 6
        fr = np.zeros((90, 160, 4), np.uint8)
        fr[20:70, 20:140] = (255, 255, 255, 255)
        frames = [fr if i < on_frames else np.zeros_like(fr) for i in range(n)]
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 6.0]},
                'events': [{'type': 'words_q', 'id': 'w', 'at': 0.5, 'text': ' '.join(['word'] * text_words)}]}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))

    def test_dense_graphic_rushed_to_the_exit_fails_and_a_held_one_passes(self):
        self.assertEqual(verdict(dwell.run(self.ctx(int(FPS * 1.5), 15))), 'FAIL')
        self.assertEqual(verdict(dwell.run(self.ctx(int(FPS * 5.5), 15))), 'PASS')

    def test_notes_on_screen_long_before_the_last_landing_are_already_read(self):
        n = FPS * 60
        fr = np.zeros((90, 160, 4), np.uint8)
        fr[20:70, 20:140] = (255, 255, 255, 255)
        write_overlay(self.path('o.mov'), [fr if i < FPS * 50 else np.zeros_like(fr) for i in range(n)])
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        words = ' '.join(['word'] * 12)
        events = [{'type': 'words_q', 'id': 'a', 'at': 1.0, 'text': words}, {'type': 'words_q', 'id': 'b', 'at': 10.0, 'text': words}, {'type': 'words_q', 'id': 'c', 'at': 47.0, 'text': 'vegan'}]
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 60.0]}, 'events': events}
        self.assertEqual(verdict(dwell.run(ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov')))), 'PASS')
        events[0]['at'], events[1]['at'], events[2]['at'] = 48.0, 48.5, 49.0      # the same notes landing late are still unread
        self.assertEqual(verdict(dwell.run(ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov')))), 'FAIL')

    def test_sound_names_asset_kinds_and_directions_are_not_words_to_read(self):
        ev = {'type': 'route', 'id': 'r', 'text': 'Byproduct Founder', 'sounds': {'draw': 'w_draw1', 'out': 'w_card_out'}, 'draw': 'w_draw2', 'out': 'w_card_out', 'anchor': 'lm',
              'what': 'recipe', 'from': 'chimney', 'out_dir': 'W'}
        got = dwell.element_strings(ev, set(limits()['dwell']['non_text_keys']))
        self.assertEqual(got, ['Byproduct Founder'])

    def test_box_c2_text_is_read_without_a_per_type_field_list(self):
        ctx = self.ctx(int(FPS * 1.5), 1)
        ctx.spec['events'] = [{'type': 'box_c2', 'id': 'q', 'at': 0.5, 'size': 44, 'exit': 'slide',
                               'text': ' '.join(['word'] * 15)}]
        fs = dwell.run(ctx)
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('15 words', fs[0].message)

    def test_words_spoken_as_they_land_count_as_read(self):
        words = ' '.join(f'w{i}' for i in range(15))
        ctx = self.ctx(int(FPS * 3.0), 1)
        ctx.spec['events'] = [{'type': 'box_c2', 'id': 'q', 'at': 0.5, 'text': words}]
        self.assertEqual(verdict(dwell.run(ctx)), 'FAIL')           # no word timings: the full need applies
        jsonio.write(self.path('w.json'), [{'w': f'w{i}', 's': 0.6 + i * 0.2, 'e': 0.7 + i * 0.2} for i in range(15)])
        ctx.words_path = self.path('w.json')
        fs = dwell.run(ctx)
        self.assertIn('15 spoken as they land', fs[0].message)
        self.assertEqual(verdict(fs), 'FAIL', 'dense graphic still needs 4 s after the last element lands')
        ctx2 = self.ctx(int(FPS * 5.0), 1)
        ctx2.spec['events'] = ctx.spec['events']
        ctx2.words_path = self.path('w.json')
        self.assertEqual(verdict(dwell.run(ctx2)), 'PASS')

    def test_a_spec_with_no_string_anywhere_is_n_a_for_dwell(self):
        ctx = self.ctx(int(FPS * 1.5), 1)
        ctx.spec['events'] = [{'type': 'icons', 'id': 'bananas', 'at': 0.5, 'n': 8, 'file': 'banana.png'}]
        fs = dwell.run(ctx)
        self.assertEqual(verdict(fs), 'PASS')
        self.assertTrue(fs[0].data['empty_set'])
        self.assertIn('no on-screen text', fs[0].message)

    def test_string_free_pictures_are_picture_only(self):
        c = limits()['dwell']
        for t in ('overlay_b', 'overlay_b2', 'figure_s'):
            self.assertIn(t, c['picture_types'])

    def test_a_picture_only_graphic_is_n_a_but_a_labelled_one_is_still_timed(self):
        ctx = self.ctx(int(FPS * 1.5), 1)
        ctx.spec['events'] = [{'type': 'overlay_b2', 'id': 'b', 'at': 0.5, 'file': 'clip.mp4', 'muted': True}]
        fs = dwell.run(ctx)
        self.assertEqual(verdict(fs), 'PASS')
        self.assertTrue('picture only' in fs[0].message or 'no on-screen text' in fs[0].message)
        self.assertFalse((fs[0].data or {}).get('not_measured'))
        ctx.spec['events'] = [{'type': 'overlay_b', 'id': 'b', 'at': 0.5, 'file': 'clip.mp4', 'label': ' '.join(['word'] * 15)}]
        self.assertEqual(verdict(dwell.run(ctx)), 'FAIL')

    def test_a_graphic_of_only_non_content_elements_is_n_a_for_dwell(self):
        ctx = self.ctx(int(FPS * 1.5), 1)
        ctx.spec['events'] = [{'type': 'pause', 'id': 'p', 'at': 0.5}]
        fs = dwell.run(ctx)
        self.assertEqual(verdict(fs), 'PASS')
        self.assertIn('n/a for reading time', fs[0].message)

    def test_unreadable_text_is_not_measured_not_passed(self):
        ctx = self.ctx(int(FPS * 1.5), 1)
        ctx.spec['events'] = [{'type': 'mystery', 'id': 'q', 'at': 0.5, 'size': 44}, {'type': 'words_q', 'id': 'far', 'at': 5.5, 'text': 'elsewhere'}]      # text exists, but none resolves to the graphic
        fs = dwell.run(ctx)
        self.assertEqual(verdict(fs), 'WARN')
        self.assertTrue(fs[0].data['not_measured'])

    def test_short_label_needs_only_the_minimum(self):
        self.assertEqual(verdict(dwell.run(self.ctx(int(FPS * 2.5), 2))), 'PASS')


class TypeSync(Base):
    TEXT = 'abcdefghijkl'

    def ctx(self, key_chars, tail_s=0.0):
        n = int(FPS * 3.0)
        frames = []
        for i in range(n):
            fr = np.zeros((180, 320, 4), np.uint8)
            if i >= 3:
                fr[0:60, 0:140] = (240, 235, 220, 255)                    # the strip appears
                for k in range(12):
                    if i >= 6 + 2 * k:
                        fr[15:30, 8 + k * 7:8 + k * 7 + 5] = (20, 20, 20, 255)       # one more letter every other frame (12 cps)
            frames.append(fr)
        write_overlay(self.path('overlay.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((180, 320, 3), 40, np.uint8)] * n)
        sr = 16000
        audio = np.zeros(sr * 3)
        for k in range(key_chars):
            at = (6 + 2 * k) / FPS
            audio[int(at * sr):int(at * sr) + 80] = 0.06 * np.hanning(80)
        if tail_s:
            end = (6 + 2 * 11) / FPS
            audio[int(end * sr):int((end + tail_s) * sr)] = 0.02
        with wave.open(self.path('sfx-only.wav'), 'wb') as f:
            f.setnchannels(1)
            f.setsampwidth(2)
            f.setframerate(sr)
            f.writeframes((audio * 32767).astype(np.int16).tobytes())
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 3.0]},
                'events': [{'type': 'box_f', 'id': 't', 'text': self.TEXT, 'size': 10, 'pos': [8, 12], 'cps': 12, 'at': 0.1}]}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('overlay.mov'))

    def test_a_key_sound_for_every_character_passes(self):
        self.assertEqual(verdict(type_sync.run(self.ctx(12))), 'PASS')

    def test_sound_that_stops_before_the_typing_ends_fails(self):
        fs = type_sync.run(self.ctx(5))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertTrue(any('typed characters' in f.message and f.data['chars'] >= 3 for f in fs if f.status == 'FAIL'))

    def test_sound_that_runs_on_after_the_last_character_fails(self):
        fs = type_sync.run(self.ctx(12, tail_s=0.4))
        self.assertTrue(any('past the last typed character' in f.message for f in fs if f.status == 'FAIL'))

    def test_typed_text_without_cps_is_not_measured_not_skipped(self):
        ctx = self.ctx(12)
        ctx.spec['events'] = [{'type': 'typewriter', 'id': 'u', 'text': 'abc', 'pos': [8, 12]},
                              {'type': 'box_f', 'id': 'v', 'text': 'abc', 'typed': True, 'pos': [8, 12]}]
        self.assertIsNone(type_sync.needs(ctx))
        fs = type_sync.run(ctx)
        self.assertEqual(verdict(fs), 'WARN')
        self.assertEqual(sum(1 for f in fs if f.data.get('not_measured')), 2)
        self.assertIn('declare cps', fs[0].message)

    def test_missing_sfx_stem_is_not_measured(self):
        ctx = self.ctx(12)
        os.remove(self.path('sfx-only.wav'))
        fs = type_sync.run(ctx)
        self.assertEqual(verdict(fs), 'WARN')
        self.assertTrue(fs[0].data['not_measured'])


class Movement(Base):
    def ctx(self, shift_at, playing=False):
        """An overlay with a textured piece at x 600-900, y 400-560 whose position over time is shift_at(i) -> (dx, dy) px."""
        n = FPS * 6
        rng = np.random.default_rng(3)
        patch = (rng.integers(40, 215, (160, 300, 1)) * np.ones((1, 1, 3))).astype(np.uint8)
        frames = []
        for i in range(n):
            fr = np.zeros((1080, 1920, 4), np.uint8)
            dx, dy = shift_at(i)
            piece = np.zeros((200, 340, 4), np.uint8)       # the piece with a margin, so its alpha edge moves with it
            piece[20:180, 20:320, :3] = patch
            piece[20:180, 20:320, 3] = 255
            if playing:      # a video playing inside a card: new picture every frame, the card itself (its alpha) does not move
                piece[40:160, 40:300, :3] = rng.integers(0, 255, (120, 260, 1)) * np.ones((1, 1, 3), np.uint8)
            fr[380:580, 580:920] = cv2.warpAffine(piece, np.float32([[1, 0, dx], [0, 1, dy]]), (340, 200))
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        jsonio.write(self.path('timeline.json'), {'duration_s': 6.0, 'boxes': [{'id': 'c', 't0': 0.2, 'box': [600, 400, 900, 560]}]})
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 6.0]}, 'events': [{'type': 'box_d2', 'id': 'c'}]}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'), timeline=self.path('timeline.json'))

    def test_a_slow_drift_passes_and_still_passes(self):
        drift = lambda i: (2 * np.sin(2 * np.pi * i / FPS / 6.0), 1.2 * np.sin(2 * np.pi * i / FPS / 5.0))      # about 4 px end to end
        fs = movement.run(self.ctx(drift))
        self.assertEqual(verdict(fs), 'PASS')
        self.assertIn('no fast small-step shuffling', fs[0].message)
        self.assertEqual(verdict(movement.run(self.ctx(lambda i: (0, 0)))), 'PASS')

    def test_a_video_playing_inside_a_still_card_is_not_drifting_movement(self):
        fs = movement.run(self.ctx(lambda i: (0, 0), playing=True))
        self.assertEqual(verdict(fs), 'PASS')
        self.assertIn('holds still', fs[0].message)

    def test_a_wide_slow_drift_fails_on_travel(self):
        wide = lambda i: (9 * np.sin(2 * np.pi * i / FPS / 6.0), 5 * np.sin(2 * np.pi * i / FPS / 5.0))     # about 20 px end to end, like 04 D
        fs = movement.run(self.ctx(wide))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('slow and small, not wide', fs[0].message)

    def test_fast_small_steps_that_go_nowhere_fail(self):
        rng = np.random.default_rng(5)
        walk = np.cumsum(rng.choice([-2, -1, 1, 2], (FPS * 6, 2)), axis=0) * 0 + rng.choice([-2, -1, 1, 2], (FPS * 6, 2))   # +-1-2 px every frame, no net travel
        fs = movement.run(self.ctx(lambda i: tuple(walk[i])))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('shuffles', fs[0].message)

    def test_a_short_settle_under_the_run_limit_passes(self):
        rng = np.random.default_rng(7)
        wobble = rng.choice([-2, -1, 1, 2], (FPS * 6, 2))
        fs = movement.run(self.ctx(lambda i: tuple(wobble[i]) if i < int(FPS * 1.0) else (0, 0)))
        self.assertEqual(verdict(fs), 'PASS')


class Backing(Base):
    PAGE = 232

    def ctx(self, backing_lum, other_lum=None):
        n = FPS * 4
        pv = np.full((1080, 1920, 3), self.PAGE, np.uint8)
        pv[300:420, 400:900] = backing_lum                           # the strip's backing; its text sits in the middle
        pv[340:380, 480:820] = 20
        write_video(self.path('p.mp4'), [pv] * n)
        jsonio.write(self.path('timeline.json'), {'duration_s': 4.0, 'boxes': [{'id': 's', 't0': 0.5, 'box': [400, 300, 900, 420]}]})
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 4.0]}, 'events': [{'type': 'box_f', 'id': 's', 'text': 'x'}]}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, timeline=self.path('timeline.json'))

    def test_white_backing_and_black_tape_stand_out_and_a_same_tone_strip_fails(self):
        self.assertEqual(verdict(backing.run(self.ctx(250))), 'PASS')       # a light frame on a mid-tone surface
        self.assertEqual(verdict(backing.run(self.ctx(20))), 'PASS')        # a much darker stripe
        fs = backing.run(self.ctx(220))                                      # newsprint grey a little under the page
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('same tone', fs[0].message)
        self.assertEqual(verdict(backing.run(self.ctx(232))), 'FAIL')

    def test_box_k_is_measured_from_its_timeline_box_and_without_one_is_not_a_pass(self):
        ctx = self.ctx(220)
        ctx.spec['events'][0]['type'] = 'box_k'
        self.assertEqual(verdict(backing.run(ctx)), 'FAIL')
        self.assertEqual(verdict(backing.run(self.ctx(250))), 'PASS')
        ctx.timeline = {'boxes': []}
        fs = backing.run(ctx)
        self.assertEqual(verdict(fs), 'WARN')
        self.assertTrue(fs[0].data['not_measured'])

    def test_element_without_a_box_or_page_is_not_measured(self):
        ctx = self.ctx(250)
        ctx.spec['events'][0]['id'] = 'unknown'
        fs = backing.run(ctx)
        self.assertEqual(verdict(fs), 'WARN')
        self.assertTrue(fs[0].data['not_measured'])
        self.assertIsNone(backing.needs(self.ctx(250)))
        self.assertIsNotNone(backing.needs(ctx_for(self.tmp, self.path('p.mp4'), {'events': [{'type': 'box_f', 'id': 's'}]})))


class Cli(Base):
    def test_a_video_with_no_spec_is_reported_not_measured_not_crashed(self):
        from rendercheck import cli
        write_video(self.path('p.mp4'), moving(24))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = cli.main(['check', self.path('p.mp4'), '--limits', LIMITS, '--spec', self.path('missing.json')])
        self.assertEqual(rc, 0)
        self.assertIn('no spec, not measured', buf.getvalue())
        self.assertNotIn('PASS', buf.getvalue())

    def test_a_spec_with_no_element_of_a_kind_reports_an_empty_set_pass_for_type_sync(self):
        from rendercheck import cli
        write_video(self.path('p.mp4'), moving(24))
        write_overlay(self.path('o.mov'), [np.zeros((90, 160, 4), np.uint8)] * 24)
        jsonio.write(self.path('s.json'), {'duration_s': 3.0, 'edit': {'preview': [0, 1]}, 'events': [{'type': 'box_b', 'id': 'p', 'at': 0.0}]})
        with contextlib.redirect_stdout(io.StringIO()):
            rc = cli.main(['check', self.path('p.mp4'), '--limits', LIMITS, '--spec', self.path('s.json'), '--overlay', self.path('o.mov'),
                           '--only', 'type-sync', '--json', self.path('out.json')])
        self.assertEqual(rc, 0)
        report = jsonio.read(self.path('out.json'))[self.path('p.mp4')]
        for name in ('type-sync',):
            self.assertTrue(report[name][0]['data']['empty_set'], name)

    def test_a_check_with_no_limits_row_is_not_run_and_says_so_and_the_limits_file_is_required(self):
        from rendercheck import cli
        import argparse
        write_video(self.path('p.mp4'), moving(6))
        cfg = limits()
        del cfg['jitter']
        args = argparse.Namespace(overlay=None, timeline=None, words=None, source_words=None, recipe=None, cache_dir=None)
        spec = self.path('s.json')
        jsonio.write(spec, {'events': [{'type': 'box_b', 'id': 'p', 'at': 0.0}]})
        _, results, skipped = cli.check_one(self.path('p.mp4'), spec, args, cfg, {'jitter', 'joins'})
        self.assertNotIn('jitter', results)
        self.assertIn('no limits for jitter', skipped['jitter'])
        self.assertIn('joins', results)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as refused:
            cli.main(['check', self.path('p.mp4')])
        self.assertEqual(refused.exception.code, 2)

    def test_the_last_line_is_a_json_result_that_names_the_failed_checks(self):
        from rendercheck import cli
        write_video(self.path('p.mp4'), moving(24))
        jsonio.write(self.path('s.json'), {'duration_s': 30.0, 'edit': {'preview': [0, 1]},
                                          'events': [{'type': 'box_b', 'id': f'p{i}', 'at': float(i)} for i in range(6)]})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            cli.main(['check', self.path('p.mp4'), '--limits', LIMITS, '--spec', self.path('s.json'), '--only', 'jitter,joins'])
        result = json.loads(buf.getvalue().strip().splitlines()[-1])['result']
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertEqual(result['videos'][0]['failed'], ['jitter'])
        self.assertNotIn('joins', result['videos'][0]['failed'])

    def test_exit_code_is_non_zero_on_a_fail(self):
        from rendercheck import cli
        write_video(self.path('p.mp4'), moving(24))
        jsonio.write(self.path('s.json'), {'duration_s': 30.0, 'edit': {'preview': [0, 1]},
                                          'events': [{'type': 'box_b', 'id': f'p{i}', 'at': float(i)} for i in range(6)]})
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['check', self.path('p.mp4'), '--limits', LIMITS, '--spec', self.path('s.json'), '--only', 'jitter']), 1)
        jsonio.write(self.path('s.json'), {'duration_s': 3.0, 'edit': {'preview': [0, 1]}, 'events': []})
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['check', self.path('p.mp4'), '--limits', LIMITS, '--spec', self.path('s.json'), '--only', 'joins']), 0)


class PinScope(Base):
    def test_every_config_section_a_check_reads_is_covered_by_its_pin(self):
        import re
        from rendercheck import pins
        for name, (module, sections, *_) in pins.CHECK_SECTIONS.items():
            src = pins._read(f'checks/{module}.py')
            read = set(re.findall(r"cfg\[['\"]([a-z_]+)['\"]\]", src)) & set(limits())
            self.assertLessEqual(read, set(sections) | set(pins.SHARED_SECTIONS), f'{name} reads a config section its pin does not cover')

    def test_a_dwell_only_config_change_leaves_every_other_check_pin_alone(self):
        from rendercheck import pins
        before = pins.check_pins(limits())
        cfg = limits()
        cfg['dwell']['min_hold_s'] = cfg['dwell']['min_hold_s'] + 0.1
        after = pins.check_pins(cfg)
        reads_dwell = {k for k, (_, sections, *_) in pins.CHECK_SECTIONS.items() if 'dwell' in sections}      # dwell itself and the checks that read its sections
        self.assertEqual({k for k in before if before[k] != after[k]}, reads_dwell)

    def test_a_shared_section_change_voids_every_check_and_a_check_code_change_voids_only_that_check(self):
        from rendercheck import pins
        before = pins.check_pins(limits())
        cfg = limits()
        cfg['frame']['width'] += 1
        self.assertEqual({k for k in before if before[k] == pins.check_pins(cfg)[k]}, set())
        real = pins._read
        pins._read = lambda rel: real(rel) + ('# edit' if rel == 'checks/movement.py' else '')
        try:
            after = pins.check_pins(limits())
        finally:
            pins._read = real
        self.assertEqual({k for k in before if before[k] != after[k]}, {'movement'})


class PlainVideo(Base):
    def test_overlay_only_checks_are_an_empty_set_and_joins_still_run(self):
        from rendercheck import cli
        import argparse
        write_video(self.path('p.mp4'), moving(6))
        args = argparse.Namespace(overlay=None, timeline=None, words=None, source_words=None, recipe=None, cache_dir=None)
        ctx, results, skipped = cli.check_one(self.path('p.mp4'), None, args, limits(), {'movement', 'dwell', 'text', 'in-frame', 'joins'})
        self.assertTrue(ctx.plain)
        for name in ('movement', 'dwell', 'text', 'in-frame'):
            self.assertTrue(results[name][0].data.get('empty_set'), name)
            self.assertIn('no overlay', results[name][0].message)
        self.assertIn('joins', results)
        self.assertEqual(skipped, {})


class SpellingFixes(Base):
    def test_a_misheard_name_is_corrected_with_its_punctuation_kept(self):
        write_video(self.path('p.mp4'), moving(6))
        jsonio.write(self.path('w.json'), [{'w': 'Catrin', 's': 0.0, 'e': 0.3}, {'w': 'Catrin?', 's': 0.4, 'e': 0.7}, {'w': 'catrin', 's': 0.8, 'e': 1.0}, {'w': 'table', 's': 1.1, 'e': 1.3}])
        cfg = limits()
        cfg['word_clip']['spelling_fixes'] = {'Catrin': 'Katrin'}
        words = Context(self.path('p.mp4'), {}, cfg, words=self.path('w.json')).preview_words()
        self.assertEqual([w['w'] for w in words], ['Katrin', 'Katrin?', 'Katrin', 'table'])


class OwnStopAndWordAnchors(unittest.TestCase):
    def test_speakers_own_stop_needs_a_word_ending_there_and_a_gap_after_it(self):
        ctx = Context.__new__(Context)
        ctx.cfg = limits()
        ctx.source_words = [{'w': 'table.', 's': 1019.7, 'e': 1020.1}, {'w': 'so', 's': 1020.34, 'e': 1020.39}]
        self.assertTrue(word_clip._speakers_own_stop(ctx, 1020.102))
        self.assertFalse(word_clip._speakers_own_stop(ctx, 1019.9))              # inside a word, not at its end
        ctx.source_words = [{'w': 'table.', 's': 1019.7, 'e': 1020.1}, {'w': 'so', 's': 1020.15, 'e': 1020.39}]
        self.assertFalse(word_clip._speakers_own_stop(ctx, 1020.102))            # speech runs on: the cut itself would chop it
        ctx.source_words = None
        self.assertFalse(word_clip._speakers_own_stop(ctx, 1020.102))

    def test_parakeet_word_lists_load_without_their_blank_tokens(self):
        ctx = Context.__new__(Context)
        path = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False)
        json.dump({'words': [{'text': 'Anyway,', 'start': 1.0, 'end': 1.5}, {'text': ' ', 'start': 1.5, 'end': 1.8}]}, path)
        path.close()
        self.assertEqual(ctx._load_source_words(path.name), [{'w': 'Anyway,', 's': 1.0, 'e': 1.5}])

    def test_an_event_timed_by_word_anchors_starts_with_its_first_timeline_child(self):
        ctx = Context.__new__(Context)
        ctx.cfg = limits()
        ctx.timeline = {'elements': [{'id': 'water-label0', 'at': 5.46}, {'id': 'water-leader0', 'at': 5.16}, {'id': 'other-label0', 'at': 1.0}]}
        ev = {'type': 'box_m', 'id': 'water', 'labels': [{'text': 'x', 'at': ['thirty', 0.0]}]}
        self.assertEqual(ctx.element_start(ev), 5.16)


class NestedTiming(unittest.TestCase):
    def test_event_timed_only_by_its_children_starts_with_the_first_child(self):
        ctx = Context.__new__(Context)
        ctx.timeline = None
        ev = {'type': 'box_l', 'id': 'x', 'root': {'text': 'tea', 'at': 0.3}, 'leaves': [{'text': 'a', 'at': 1.2}]}
        self.assertEqual(ctx.element_start(ev), 0.3)
        self.assertIsNone(ctx.element_start({'type': 'still_r', 'id': 'y'}))
