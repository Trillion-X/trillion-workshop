"""One failing and one passing synthetic case per check (sound-balance, sound-harsh, sound-loops, sound-sync, settle, internal-text, text-size, tempo, zoom,
placement, info-added, motion-blur, math-shown, cue, filler-words, broll, camera). Run: python3 test/run_tests.py"""
import json
import os
import subprocess
import sys
import unittest
import wave

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import Base, FPS, add_audio, ctx_for, write_overlay, write_video  # noqa: E402
from rendercheck.checks import broll, filler_words, camera, cue, math_shown, info_added, internal_text, motion_blur, placement, settle, sound_balance, sound_harsh, sound_loops, sound_sync, tempo, text_size, zoom  # noqa: E402
from rendercheck.report import verdict  # noqa: E402

SR = 22050


def write_wav(path, x, sr=SR):
    with wave.open(path, 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())


def burst(kind, dur, amp, rng):
    n = int(dur * SR)
    env = np.exp(-np.arange(n) / (0.25 * n))
    if kind == 'tone':
        return amp * env * np.sin(2 * np.pi * 440 * np.arange(n) / SR)
    noise = rng.standard_normal(n)
    if kind == 'hiss':      # high-passed noise: almost all energy above 4 kHz
        noise = np.diff(noise, prepend=0.0)
        noise = np.diff(noise, prepend=0.0)
    return amp * env * noise / np.abs(noise).max()


class SoundBase(Base):
    def option(self, events, seconds=6.0, voice=0.1):
        """A preview with a voice-like noise bed, an overlay, a timeline with the sounds and an sfx-only.wav with one burst per event: (kind, t, burst kind, dur, amp)."""
        rng = np.random.default_rng(3)
        n = int(FPS * seconds)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        add_audio(self.path('p.mp4'), voice * rng.standard_normal(int(16000 * seconds)), 16000)
        write_overlay(self.path('o.mov'), [np.zeros((90, 160, 4), np.uint8)] * n)
        sfx = np.zeros(int(SR * seconds))
        for _, t, k, dur, amp in events:
            b = burst(k, dur, amp, rng)
            a = int(t * SR)
            sfx[a:a + len(b)] += b[:len(sfx) - a]
        write_wav(self.path('sfx-only.wav'), sfx)
        with open(self.path('timeline.json'), 'w') as f:
            json.dump({'sounds': [{'kind': k, 't': t} for k, t, *_ in events], 'elements': [], 'boxes': []}, f)
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': 0}, 'preview': [0, seconds]}}, overlay=self.path('o.mov'))


class SoundBalance(SoundBase):
    def test_an_exit_whoosh_far_quieter_than_the_appear_sound_fails_and_an_equal_one_passes(self):
        quiet = self.option([('slide_in', 1.0, 'tone', 0.3, 0.6), ('slide_out', 4.0, 'tone', 0.3, 0.08)])
        self.assertEqual(verdict(sound_balance.run(quiet)), 'FAIL')
        equal = self.option([('slide_in', 1.0, 'tone', 0.3, 0.6), ('slide_out', 4.0, 'tone', 0.3, 0.6)])
        self.assertEqual(verdict(sound_balance.run(equal)), 'PASS')


class DeliveredMix(Base):
    """Balance read on the delivered mix against the sound base (the same range without the added sounds): an effect the stem has at t but the video does not is not heard."""
    def pair(self, mixed_at, stem_at=1.0, seconds=6.0):
        rng = np.random.default_rng(8)
        voice = 0.1 * rng.standard_normal(int(16000 * seconds))
        n = int(FPS * seconds)
        for name, extra in (('plain.mp4', None), ('mixed.mp4', mixed_at)):
            audio = voice.copy()
            if extra is not None:
                b = burst('tone', 0.3, 0.6, rng)[::1]
                b16 = np.interp(np.arange(int(0.3 * 16000)) / 16000, np.arange(len(b)) / SR, b)
                a = int(extra * 16000)
                audio[a:a + len(b16)] += b16
            write_video(self.path(name), [np.full((90, 160, 3), 40, np.uint8)] * n)
            write_wav(self.path('v.wav'), audio, 16000)
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', self.path(name), '-i', self.path('v.wav'), '-c:v', 'copy', '-c:a', 'alac', '-shortest', self.path('t.mp4')], check=True)
            os.replace(self.path('t.mp4'), self.path(name))
        stem = np.zeros(int(SR * seconds))
        b = burst('tone', 0.3, 0.6, rng)
        stem[int(stem_at * SR):int(stem_at * SR) + len(b)] += b
        os.makedirs(self.path('out'), exist_ok=True)
        write_wav(self.path('out/sfx-only.wav'), stem)
        write_overlay(self.path('out/overlay.mov'), [np.zeros((90, 160, 4), np.uint8)] * n)
        with open(self.path('out/timeline.json'), 'w') as f:
            json.dump({'sounds': [{'kind': 'pop', 't': stem_at}], 'elements': [], 'boxes': []}, f)
        return ctx_for(self.tmp, self.path('mixed.mp4'), {'sound_base': 'plain.mp4', 'edit': {'overlay': {'at': 0}, 'preview': [0, seconds]}}, overlay=self.path('out/overlay.mov'))

    def test_the_effect_is_read_from_the_mix_and_a_misplaced_one_is_not_heard(self):
        from rendercheck import sfx
        good = self.pair(mixed_at=1.0)
        self.assertTrue(sfx.effects(good)[2].startswith('the delivered mix'))
        self.assertEqual(verdict(sound_balance.run(good)), 'PASS')
        bad = self.pair(mixed_at=3.5)
        self.assertEqual(verdict(sound_balance.run(bad)), 'FAIL')

    def test_without_a_sound_base_the_stem_is_read_and_says_so(self):
        from rendercheck import sfx
        ctx = self.pair(mixed_at=1.0)
        os.remove(self.path('plain.mp4'))
        ctx._cache.clear()
        self.assertIn('effect stem', sfx.effects(ctx)[2])


class SoundHarsh(SoundBase):
    def test_a_hissing_scratch_fails_and_a_soft_tone_passes(self):
        self.assertEqual(verdict(sound_harsh.run(self.option([('rasp', 1.0, 'hiss', 0.4, 0.5)]))), 'FAIL')
        self.assertEqual(verdict(sound_harsh.run(self.option([('pop', 1.0, 'tone', 0.4, 0.5)]))), 'PASS')

    def test_a_harsh_sound_declared_on_purpose_is_only_a_note(self):
        ctx = self.option([('rasp', 1.0, 'hiss', 0.4, 0.5)])
        ctx.spec['harsh_sound_purpose'] = {'rasp': 'a deliberate scrape for the angry beat'}
        self.assertEqual(verdict(sound_harsh.run(ctx)), 'PASS')


class SoundLoops(SoundBase):
    def test_one_long_recording_laid_down_six_times_fails_and_a_short_hit_roll_passes(self):
        loop = self.option([('rustle', 0.2 + i, 'noise', 0.6, 0.5) for i in range(5)], seconds=6.5)
        # the same noise burst every time: the generator seeds once per call, so lay the one recording down by hand
        rng = np.random.default_rng(9)
        one = burst('noise', 0.6, 0.5, rng)
        sfx = np.zeros(int(SR * 6.5))
        for i in range(5):
            a = int((0.2 + i) * SR)
            sfx[a:a + len(one)] += one
        write_wav(self.path('sfx-only.wav'), sfx)
        loop._cache.clear()
        self.assertEqual(verdict(sound_loops.run(loop)), 'FAIL')
        roll = self.option([('thump', 0.5 + 0.2 * i, 'tone', 0.05, 0.5) for i in range(8)])
        self.assertEqual(verdict(sound_loops.run(roll)), 'PASS')


class SoundSync(Base):
    def option(self, stem_at, overlay_at=3.0, seconds=9.0):
        """A preview with a voice-like bed and the effect stem mixed in at stem_at seconds; the overlay starts at overlay_at."""
        rng = np.random.default_rng(4)
        n = int(FPS * seconds)
        sfx = np.zeros(int(SR * (seconds - overlay_at)))
        for t in (0.5, 1.7, 3.1):
            b = burst('noise', 0.3, 0.5, rng)
            a = int(t * SR)
            sfx[a:a + len(b)] += b
        voice = 0.05 * rng.standard_normal(int(16000 * seconds))
        stem16 = np.interp(np.arange(int(16000 * (seconds - overlay_at))) / 16000, np.arange(len(sfx)) / SR, sfx)
        a = int(stem_at * 16000)
        voice[a:a + len(stem16)] += stem16[:len(voice) - a]
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        write_wav(self.path('voice.wav'), voice, 16000)
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', self.path('p.mp4'), '-i', self.path('voice.wav'), '-c:v', 'copy', '-c:a', 'alac', '-shortest', self.path('q.mp4')], check=True)      # lossless: the check is about placement, not codec noise
        os.replace(self.path('q.mp4'), self.path('p.mp4'))
        write_overlay(self.path('o.mov'), [np.zeros((90, 160, 4), np.uint8)] * n)
        write_wav(self.path('sfx-only.wav'), sfx)
        with open(self.path('timeline.json'), 'w') as f:
            json.dump({'sounds': [{'kind': 'pop', 't': t} for t in (0.5, 1.7, 3.1)], 'elements': [], 'boxes': []}, f)
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': overlay_at}, 'preview': [0, seconds]}}, overlay=self.path('o.mov'))

    def test_a_stem_placed_at_the_overlay_start_passes_and_one_at_preview_zero_fails(self):
        self.assertEqual(verdict(sound_sync.run(self.option(3.0))), 'PASS')
        early = sound_sync.run(self.option(0.0))
        self.assertEqual(verdict(early), 'FAIL')
        self.assertIn('early', early[0].message)

    def test_a_stem_two_frames_late_fails_and_one_frame_passes(self):
        self.assertEqual(verdict(sound_sync.run(self.option(3.0 + 2.2 / FPS))), 'FAIL')
        self.assertEqual(verdict(sound_sync.run(self.option(3.0 + 0.9 / FPS))), 'PASS')


class Settle(Base):
    def ctx(self, drifter_sway=0, card_sway=0, drifter=None, card=None, drift=None):
        """A picture-sized rect (left) and a card-sized rect (right) that sway the given overlay pixels after landing; `drifter` and `card` are the spec events (type, drift)."""
        n = FPS * 8
        frames = []
        for i in range(n):
            fr = np.zeros((90, 160, 4), np.uint8)
            sway = lambda amp: int(round(amp * np.sin(i / FPS * 2 * np.pi / 3))) if i > FPS else 0
            fr[20:60, 10 + sway(drifter_sway):50 + sway(drifter_sway)] = (255, 255, 255, 255)
            fr[20:60, 100 + sway(card_sway):140 + sway(card_sway)] = (255, 255, 255, 255)
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        with open(self.path('timeline.json'), 'w') as f:
            json.dump({'elements': [{'id': 'drifter', 'at': 0.0}, {'id': 'card', 'at': 0.0}], 'sounds': [],
                       'boxes': [{'id': 'drifter', 't0': 0.0, 'box': [60, 200, 760, 760]}, {'id': 'card', 't0': 0.0, 'box': [1140, 200, 1860, 760]}]}, f)
        drifter = drifter or {'type': 'box_b', 'drift': {'px': 2, 'period_s': 6.0}}
        card = card or {'type': 'words_q'}
        events = [{**drifter, 'id': 'drifter', 'at': 0.0}, {**card, 'id': 'card', 'at': 0.0}]
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': 0}, 'preview': [0, 8.0]}, 'events': events}, overlay=self.path('o.mov'))

    def test_a_document_that_keeps_swaying_fails_and_one_that_sits_still_passes(self):
        self.assertEqual(verdict(settle.run(self.ctx(card_sway=8))), 'FAIL')
        self.assertEqual(verdict(settle.run(self.ctx())), 'PASS')

    def test_an_approved_drifting_print_is_exempt_inside_its_own_box_only(self):
        self.assertEqual(verdict(settle.run(self.ctx(drifter_sway=2))), 'PASS')
        self.assertNotIn('drags', ' '.join(f.message for f in settle.run(self.ctx(drifter_sway=2))))

    def test_a_text_card_beside_a_drifting_picture_still_fails(self):
        self.assertEqual(verdict(settle.run(self.ctx(drifter_sway=2, card_sway=8))), 'FAIL')

    def test_drift_declared_on_a_text_card_still_fails(self):
        card = {'type': 'words_q', 'drift': {'px': 2, 'period_s': 6.0}}
        self.assertEqual(verdict(settle.run(self.ctx(card_sway=8, card=card))), 'FAIL')

    def test_removed_types_are_not_exempt_and_the_drift_budget_caps_many_long_drifts(self):
        for typ in ('box_u', 'still_r'):
            self.assertEqual(verdict(settle.run(self.ctx(drifter_sway=2, drifter={'type': typ, 'drift': {'px': 2, 'period_s': 6.0}}))), 'FAIL', typ)
        ctx = self.ctx(drifter_sway=2)
        ctx.spec['events'][0]['drift'] = {'px': 8, 'period_s': 6.0}
        ctx.cfg['settle']['drift_budget_px_seconds'] = 50      # 8 px for the 8 s render is 64 px*s
        self.assertTrue(any('px*s' in f.message for f in settle.run(ctx)))
        ctx.cfg['settle']['drift_budget_px_seconds'] = 1000
        self.assertFalse(any('px*s' in f.message for f in settle.run(ctx)))

    def test_over_bound_or_too_fast_drift_is_not_exempt(self):
        self.assertEqual(verdict(settle.run(self.ctx(drifter_sway=2, drifter={'type': 'box_b', 'drift': {'px': 20, 'period_s': 6.0}}))), 'FAIL')
        self.assertEqual(verdict(settle.run(self.ctx(drifter_sway=2, drifter={'type': 'box_b', 'drift': {'px': 2, 'period_s': 1.0}}))), 'FAIL')
        self.assertEqual(verdict(settle.run(self.ctx(drifter_sway=2, drifter={'type': 'box_b'}))), 'FAIL')


class InternalText(Base):
    def ctx(self, **ev):
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * FPS)
        return ctx_for(self.tmp, self.path('p.mp4'), {'events': [{'type': 'box_r', 'id': 'l', 'at': 0.5, **ev}]})

    def test_process_notes_fail_and_a_real_credit_passes(self):
        self.assertEqual(verdict(internal_text.run(self.ctx(footer='label text: example.com listing\nread 5 Mar 2025'))), 'FAIL')
        self.assertEqual(verdict(internal_text.run(self.ctx(source='label text (excerpt): example.com listing, read 5 Mar 2025'))), 'FAIL')
        self.assertEqual(verdict(internal_text.run(self.ctx(credit="Gray's Anatomy, 1918"))), 'PASS')
        self.assertEqual(verdict(internal_text.run(self.ctx(note='see overlay.png'))), 'FAIL')


class TextSize(Base):
    def ctx(self, size):
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * FPS)
        return ctx_for(self.tmp, self.path('p.mp4'), {'events': [{'type': 'document', 'id': 'r', 'at': 0.5, 'size': size, 'drift': {'px': 2, 'period_s': 6.0}, 'pos': [80, 64]}]})

    def test_a_21_px_list_fails_and_a_40_px_one_passes(self):
        self.assertEqual(verdict(text_size.run(self.ctx(21))), 'FAIL')
        self.assertEqual(verdict(text_size.run(self.ctx(40))), 'PASS')

    def test_a_drift_amount_is_not_a_font_size(self):
        self.assertEqual(verdict(text_size.run(self.ctx(40))), 'PASS')


class Tempo(Base):
    def ctx(self, changing):
        n = FPS * 14
        frames = []
        for i in range(n):
            fr = np.zeros((90, 160, 4), np.uint8)
            fr[20:70, 20:140] = (255, 255, 255, 255)
            if changing:
                x = 20 + (i * 2) % 100
                fr[30:50, x:x + 10] = (0, 0, 0, 255)
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': 0}, 'preview': [0, 14.0]}, 'events': []}, overlay=self.path('o.mov'))

    def test_a_card_that_sits_unchanged_for_14_seconds_fails_and_one_that_keeps_changing_passes(self):
        self.assertEqual(verdict(tempo.run(self.ctx(False))), 'FAIL')
        self.assertEqual(verdict(tempo.run(self.ctx(True))), 'PASS')

    def test_the_same_file_gives_the_same_answer_every_time(self):
        ctx = self.ctx(False)
        runs = [[(f.status, f.message, f.t) for f in tempo.run(ctx)] for _ in range(3)]
        self.assertEqual(runs[0], runs[1])
        self.assertEqual(runs[0], runs[2])


class Zoom(Base):
    def ctx(self, scale):
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * FPS)
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'preview': [0, 1.0], 'scale': scale}})

    def test_zoom_in_then_a_ramp_out_fails_and_a_straight_cut_back_passes(self):
        self.assertEqual(verdict(zoom.run(self.ctx([[0, 100], [1, 108], [2, 108], [5, 100]]))), 'FAIL')
        self.assertEqual(verdict(zoom.run(self.ctx([[0, 100], [1, 108], [2, 108], [2.05, 100]]))), 'PASS')
        self.assertEqual(verdict(zoom.run(self.ctx([[0, 100], [3, 101.5], [6, 110]]))), 'PASS')


class Placement(Base):
    def ctx(self, box):
        n = FPS * 4
        rng = np.random.default_rng(5)
        vid = [np.repeat((rng.random((90, 160, 1)) * (np.arange(160) < 80)[None, :, None] * 255).astype(np.uint8), 3, axis=2) for _ in range(n)]   # all the motion is on the left half
        write_video(self.path('p.mp4'), vid, codec=('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '0'))
        ov = np.zeros((90, 160, 4), np.uint8)
        x0, y0, x1, y1 = box
        ov[y0 // 12:y1 // 12, x0 // 12:x1 // 12] = (255, 255, 255, 255)
        write_overlay(self.path('o.mov'), [np.zeros_like(ov)] * (3 * FPS) + [ov] * (n - 3 * FPS))
        with open(self.path('timeline.json'), 'w') as f:
            json.dump({'elements': [], 'sounds': [], 'boxes': [{'id': 'g', 't0': 3.0, 'box': list(box)}]}, f)
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': 0}, 'preview': [0, 4.0]}, 'events': []}, overlay=self.path('o.mov'))

    def test_a_graphic_over_the_moving_side_fails_and_one_on_the_quiet_side_passes(self):
        self.assertEqual(verdict(placement.run(self.ctx([100, 200, 500, 700]))), 'FAIL')
        self.assertEqual(verdict(placement.run(self.ctx([1300, 200, 1800, 700]))), 'PASS')

    def test_a_video_whose_only_graphic_is_a_full_frame_cover_is_not_applicable_never_a_silent_skip(self):
        ctx = self.ctx([100, 200, 500, 700])
        ctx.timeline['boxes'] = []
        ctx.spec['events'] = [{'type': 'overlay_b', 'id': 'cover', 'covers_a_roll': True, 'at': 1.0}]
        self.assertTrue(placement.needs(ctx).startswith(placement.EMPTY_SET))
        ctx.spec['events'].append({'type': 'sound', 'id': 's', 'at': 1.0})
        self.assertTrue(placement.needs(ctx).startswith(placement.EMPTY_SET))
        ctx.spec['events'].append({'type': 'box_m', 'id': 'c', 'at': 2.0})                      # a real graphic with no box: unanswered, not n/a
        self.assertFalse(placement.needs(ctx).startswith(placement.EMPTY_SET))

    def test_a_box_that_could_not_be_observed_is_not_measured_not_a_pass(self):
        ctx = self.ctx([0, 0, 1920, 1080])
        ctx.timeline['boxes'] = [{'id': 'g', 't0': 0.0, 'box': [100, 200, 500, 700]}]
        ctx.cfg['placement']['min_uncovered_frac'] = 2.0
        fs = placement.run(ctx)
        self.assertEqual(verdict(fs), 'WARN')
        self.assertTrue(fs[0].data['not_measured'])


class InfoAdded(Base):
    def ctx(self, events):
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * FPS)
        with open(self.path('w.json'), 'w') as f:
            json.dump([{'w': w, 's': 0.1 * i, 'e': 0.1 * i + 0.09} for i, w in enumerate('I add oat flour it has all the B vitamins'.split())], f)
        return ctx_for(self.tmp, self.path('p.mp4'), {'events': events}, words=self.path('w.json'))

    def test_a_card_that_repeats_the_spoken_words_fails_and_one_with_amounts_passes(self):
        repeat = [{'type': 'box_m', 'id': 'y', 'labels': [{'text': 'oat\nflour'}, {'text': 'B vitamins'}]}]
        self.assertEqual(verdict(info_added.run(self.ctx(repeat))), 'FAIL')
        adds = [{'type': 'box_g', 'id': 'y', 'title': 'Oat flour', 'caption': 'In 2 tablespoons', 'rows': [{'label': 'B1', 'value': '520%'}, {'label': 'B2', 'value': '480%'}]}]
        self.assertEqual(verdict(info_added.run(self.ctx(adds))), 'PASS')

    def test_new_words_without_a_number_fail_and_say_what_is_missing(self):
        many = [{'type': 'box_g', 'id': 'y', 'rows': [{'text': 'alpha beta gamma delta epsilon zeta theta iota'}]}]
        msg = info_added.run(self.ctx(many))[0].message
        self.assertEqual(verdict(info_added.run(self.ctx(many))), 'FAIL')
        self.assertIn('but no number', msg)
        self.assertNotIn('only repeats', msg)

    def test_a_count_up_of_his_own_figure_is_emphasis_and_moment_kind_decides(self):
        count = [{'type': 'box_h2', 'id': 'c', 'value': 976}]
        self.assertEqual(info_added.needs(self.ctx(count)), info_added.EMPTY_SET)
        ctx = self.ctx([{'type': 'box_g', 'id': 'y', 'rows': [{'text': 'iron zinc'}]}])
        ctx.spec['moment_kind'] = 'emphasis'
        self.assertEqual(info_added.needs(ctx), info_added.EMPTY_SET)
        ctx.spec['moment_kind'] = 'informational'
        self.assertIsNone(info_added.needs(ctx))

    def test_a_moment_with_no_informational_graphic_is_an_empty_set(self):
        self.assertEqual(info_added.needs(self.ctx([{'type': 'figure_t', 'id': 'c'}])), info_added.EMPTY_SET)


class MotionBlur(Base):
    def ctx(self, blurred):
        n = FPS * 4
        frames = []
        for i in range(n):
            fr = np.zeros((270, 480, 4), np.uint8)
            x = int(min(i * 40, 300))
            fr[100:180, x:x + 120] = (255, 255, 255, 255)
            if blurred and x < 300:
                fr[..., 3] = cv2.blur(fr[..., 3], (41, 1))
            frames.append(fr)
        write_overlay(self.path('o.mov'), frames)
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * n)
        with open(self.path('timeline.json'), 'w') as f:
            json.dump({'elements': [], 'boxes': [], 'sounds': [{'kind': 'slide_in', 't': 0.0}]}, f)
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'overlay': {'at': 0}, 'preview': [0, 4.0]}, 'events': []}, overlay=self.path('o.mov'))

    def test_a_hard_edged_fast_slide_fails_and_a_smeared_one_passes(self):
        self.assertEqual(verdict(motion_blur.run(self.ctx(False))), 'WARN')      # a WARN while only one known-good control exists
        self.assertEqual(verdict(motion_blur.run(self.ctx(True))), 'PASS')


class MathShown(Base):
    def ctx(self, strings):
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * FPS)
        return ctx_for(self.tmp, self.path('p.mp4'), {'events': [{'type': 'box_g', 'id': 'e', 'at': 0.5, 'rows': [{'text': t} for t in strings]}]})

    def test_a_wrong_equation_and_a_labelled_result_with_no_number_fail(self):
        self.assertEqual(verdict(math_shown.run(self.ctx(['1,500 - 976 = 624', 'deficit']))), 'FAIL')
        self.assertEqual(verdict(math_shown.run(self.ctx(['976 eaten', 'about 1,500 base rate', 'deficit']))), 'FAIL')

    def test_the_result_shown_or_the_equation_written_passes(self):
        self.assertEqual(verdict(math_shown.run(self.ctx(['976 eaten', '1,500 base rate', 'deficit 524']))), 'PASS')
        self.assertEqual(verdict(math_shown.run(self.ctx(['1,500 - 976 = 524', 'a deficit', 'two meals']))), 'PASS')

    def test_numbers_that_relate_with_no_operation_fail_and_a_labelled_total_passes(self):
        self.assertEqual(verdict(math_shown.run(self.ctx(['250 g', '120 g', '370 g']))), 'FAIL')
        self.assertEqual(verdict(math_shown.run(self.ctx(['250 g', '120 g', 'total 370 g']))), 'PASS')
        self.assertEqual(math_shown.needs(self.ctx(['12', '40'])), math_shown.EMPTY_SET)


class Cue(Base):
    def ctx(self, lands, hand_at=3.0):
        """Footage with a hand moving under the spot from hand_at s; a ring that lands at `lands` seconds from the overlay start (overlay at 0)."""
        n = FPS * 10
        rng = np.random.default_rng(2)
        frames = []
        for i in range(n):
            fr = np.full((108, 192, 3), 40, np.uint8)
            if i / FPS >= hand_at:
                fr[40:60, 90:110] = rng.integers(0, 255, (20, 20, 1))
            frames.append(fr)
        write_video(self.path('p.mp4'), frames)
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 10.0]}, 'events': [{'type': 'ring', 'id': 'ring', 'at': lands, 'track': [[lands, 960, 540]]}]}
        return ctx_for(self.tmp, self.path('p.mp4'), spec)

    def test_a_ring_that_lands_long_after_he_points_fails_and_one_on_the_cue_passes(self):
        self.assertEqual(verdict(cue.run(self.ctx(lands=7.5))), 'FAIL')
        self.assertEqual(verdict(cue.run(self.ctx(lands=3.4))), 'PASS')

    def test_a_declared_cue_replaces_the_measured_one_and_a_word_label_is_not_judged(self):
        ctx = self.ctx(lands=7.5)
        ctx.spec['events'][0]['cue_t'] = 7.2
        self.assertEqual(verdict(cue.run(ctx)), 'PASS')
        ctx.spec['events'][0]['type'] = 'box_m'
        self.assertEqual(cue.needs(ctx), cue.EMPTY_SET)


class FillerWords(Base):
    def ctx(self, text, cuts=((5.0, 6.0),)):
        words = [{'w': w, 's': 3.0 + 0.3 * i, 'e': 3.0 + 0.3 * i + 0.25} for i, w in enumerate(text.split())]
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * FPS)
        with open(self.path('w.json'), 'w') as f:
            json.dump(words, f)
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'preview': [0, 10.0], 'cuts': [list(c) for c in cuts]}}, words=self.path('w.json'))

    def test_his_fillers_fail_and_the_allowed_likes_pass(self):
        self.assertEqual(verdict(filler_words.run(self.ctx('and uhh then I went home'))), 'FAIL')
        self.assertEqual(verdict(filler_words.run(self.ctx('it is. So I went home'))), 'FAIL')
        self.assertEqual(verdict(filler_words.run(self.ctx("it's definitely like hot out here"))), 'FAIL')
        self.assertEqual(verdict(filler_words.run(self.ctx('it smells like poop and I like food'))), 'PASS')

    def test_a_video_that_edits_no_speech_is_an_empty_set_and_a_declared_keep_passes(self):
        ctx = self.ctx('and uhh then I went home', cuts=())
        self.assertEqual(filler_words.needs(ctx), filler_words.EMPTY_SET)
        kept = self.ctx('and uhh then I went home')
        kept.spec['filler_keep'] = [3.3]
        self.assertEqual(verdict(filler_words.run(kept)), 'PASS')


class Broll(Base):
    def ctx(self, seconds, shade, spec_extra=None):
        n = FPS * 12
        fr = np.zeros((90, 160, 4), np.uint8)
        frames = [np.zeros_like(fr)] * (3 * FPS) + [np.full((90, 160, 4), 255, np.uint8)] * int(seconds * FPS) + [np.zeros_like(fr)] * (n - 3 * FPS - int(seconds * FPS))
        write_overlay(self.path('o.mov'), frames)
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 12.0]}, 'events': [{'type': 'overlay_b2', 'id': 'pop', 'at': 3.0, 'covers_a_roll': True, **(spec_extra or {})}]}
        # the preview shows the cutaway's own colour while the overlay covers the frame
        vid = [np.full((90, 160, 3), shade if 3 * FPS <= i < 3 * FPS + int(seconds * FPS) else 100, np.uint8) for i in range(n)]
        write_video(self.path('p.mp4'), vid)
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))

    def test_a_short_or_ungraded_cutaway_fails_and_a_held_matching_one_passes(self):
        self.assertEqual(verdict(broll.run(self.ctx(3.0, 100))), 'FAIL')      # on screen 3 s
        self.assertEqual(verdict(broll.run(self.ctx(6.0, 160))), 'FAIL')      # a different grade
        self.assertEqual(verdict(broll.run(self.ctx(6.0, 102))), 'PASS')

    def test_a_declared_flash_cut_may_be_short(self):
        self.assertEqual(verdict(broll.run(self.ctx(2.0, 100, {'flash_cut': True}))), 'PASS')


class PlainVideo(Base):
    def test_a_pure_cut_is_an_empty_set_for_every_sound_motion_and_zoom_check(self):
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * FPS)
        ctx = ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'preview': [0, 1.0], 'cuts': [[0.2, 0.4]]}})
        self.assertTrue(ctx.plain)
        for mod in (sound_balance, sound_harsh, sound_loops, sound_sync, motion_blur, zoom, camera):
            self.assertTrue(mod.needs(ctx).startswith(mod.EMPTY_SET), mod.NAME)

    def test_exit_air_is_a_move_kind_of_motion_blur_and_an_exit_kind_of_sound_balance(self):
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * FPS)
        ctx = ctx_for(self.tmp, self.path('p.mp4'), {})
        self.assertIn('exit_air', ctx.cfg['motion_blur']['move_kinds'])
        self.assertIn('exit_air', ctx.cfg['sound_balance']['exit_kinds'])


class Camera(Base):
    def ctx(self, scale=None, events=None):
        write_video(self.path('p.mp4'), [np.full((90, 160, 3), 40, np.uint8)] * FPS)
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': {'preview': [0, 1.0], **({'scale': scale} if scale else {})}, 'events': events or []})

    def test_a_timid_or_constant_speed_push_fails_and_a_strong_eased_one_passes(self):
        self.assertEqual(verdict(camera.run(self.ctx([[0, 100], [4, 108], [5, 108], [9, 100]]))), 'FAIL')      # 8 percent over 4 s, constant speed
        msgs = ' '.join(f.message for f in camera.run(self.ctx([[0, 100], [4, 108]])))
        self.assertIn('too timid', msgs)
        self.assertIn('constant speed', msgs)
        self.assertEqual(verdict(camera.run(self.ctx([[0, 100], [0.4, 112], [1.4, 118], [4, 120]]))), 'PASS')      # quick ease in, settle, 20 percent

    def test_a_still_push_is_a_warn_and_no_push_is_an_empty_set(self):
        still = [{'type': 'still_r', 'id': 's', 'at': 0.0, 'until': 4.0, 'zoom': [1.0, 1.2]}]
        self.assertEqual(verdict(camera.run(self.ctx(events=still))), 'WARN')
        self.assertEqual(camera.needs(self.ctx()), camera.EMPTY_SET)


if __name__ == '__main__':
    unittest.main()
