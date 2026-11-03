"""cutout-bottom (a person cut-out sits on the frame edge) and bridge (every jump between spoken lines has a bridge), on synthetic media made with ffmpeg.
The bridge model is stubbed with canned answers, so the verdict logic is tested without one. Run: python3 test/run_tests.py"""
import json
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import Base, FPS, add_audio, ctx_for, limits, moving, write_overlay, write_video  # noqa: E402
from rendercheck import jsonio  # noqa: E402
from rendercheck.checks import bridge, cutout_bottom  # noqa: E402
from rendercheck.report import verdict  # noqa: E402


class CutoutBottom(Base):
    PAPER = (235, 228, 210)

    def ctx(self, gap, edge=None, declared=True, band=True):
        n = FPS * 2
        fr = np.zeros((1080, 1920, 4), np.uint8)
        fr[200:1080 - gap, 100:700] = (90, 60, 50, 255)
        write_overlay(self.path('o.mov'), [fr] * n)
        pv = np.zeros((1080, 1920, 3), np.uint8)
        pv[:, :] = self.PAPER
        pv[200:1080 - gap, 100:700] = (30, 20, 20)
        for k in range(gap if band else 0):                          # the card's drop shadow darkens the paper just under the figure
            pv[1080 - gap + k, :700] = (np.array(self.PAPER) * (0.75 + 0.25 * k / max(gap, 1))).astype(np.uint8)
            pv[1080 - gap + k, :100] = pv[1080 - gap + k, 100]
        write_video(self.path('p.mp4'), [pv] * n)
        ev = {'type': 'cutout', 'at': 0.0}
        if edge:
            ev['bottom_edge'] = edge
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 2.0]}, 'events': [ev] if declared else []}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))

    def test_flush_cutout_passes_and_floating_one_fails(self):
        self.assertEqual(verdict(cutout_bottom.run(self.ctx(0))), 'PASS')
        fs = cutout_bottom.run(self.ctx(40))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertEqual(fs[0].data['gap_px'], 40)

    def test_a_shadowed_cream_band_of_about_ten_pixels_is_found_on_the_rendered_video(self):
        fs = cutout_bottom.run(self.ctx(10))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertEqual(fs[0].data['gap_px'], 10)

    def test_overlay_and_video_frames_are_paired_by_time_not_by_index(self):
        fr = np.zeros((1080, 1920, 4), np.uint8)
        fr[200:1080, 100:700] = (90, 60, 50, 255)                    # the overlay starts at 2 s and the figure sits flush
        write_overlay(self.path('o.mov'), [fr] * (FPS * 2))
        page = np.zeros((1080, 1920, 3), np.uint8)
        page[:, :] = self.PAPER                                      # before 2 s the video shows only page
        figure = page.copy()
        figure[200:1080, 100:700] = (30, 20, 20)
        write_video(self.path('p.mp4'), [page] * (FPS * 2) + [figure] * (FPS * 2))
        spec = {'edit': {'overlay': {'at': 2.0}, 'preview': [0, 4.0]}, 'events': [{'type': 'cutout', 'at': 0.0}]}
        ctx = ctx_for(self.tmp, self.path('p.mp4'), spec, overlay=self.path('o.mov'))
        self.assertEqual(verdict(cutout_bottom.run(ctx)), 'PASS')

    def test_declared_styled_bottom_edge_may_float(self):
        self.assertEqual(verdict(cutout_bottom.run(self.ctx(40, edge='torn'))), 'PASS')

    def test_two_pixel_gap_is_within_the_limit(self):
        self.assertEqual(verdict(cutout_bottom.run(self.ctx(2))), 'PASS')

    def test_person_cutout_not_declared_as_cutout_is_not_measured_not_skipped(self):
        for ev in ({'type': 'person_matte', 'id': 'p', 'at': 0.0}, {'type': 'photo', 'id': 'p', 'kind': 'person', 'at': 0.0},
                   {'type': 'image', 'id': 'p', 'segment': True}):
            ctx = self.ctx(40, declared=False)
            ctx.spec['events'] = [ev]
            self.assertIsNone(cutout_bottom.needs(ctx), ev)
            fs = cutout_bottom.run(ctx)
            self.assertEqual(verdict(fs), 'WARN', ev)
            self.assertTrue(fs[0].data['not_measured'])
            self.assertIn('declare it', fs[0].message)

    def test_an_object_cutout_listed_as_not_a_person_is_skipped_but_other_look_alikes_are_not(self):
        ctx = self.ctx(40, declared=False)
        ctx.spec['events'] = [{'type': 'object_cutout', 'id': 'pack', 'at': 0.0}]
        self.assertIsNotNone(cutout_bottom.needs(ctx))
        ctx.spec['events'] = [{'type': 'person_cutout2', 'id': 'p', 'at': 0.0}]      # a new look-alike name is not in the limits' list
        self.assertIsNone(cutout_bottom.needs(ctx))

    def test_a_graphic_behind_the_person_that_declares_occluded_by_is_not_a_person_cutout(self):
        behind = {'type': 'word_behind', 'id': 'q', 'at': 0.0, 'matte': 'work/matte/q/matte', 'occluded_by': 'person_matte'}
        ctx = self.ctx(40, declared=False)
        ctx.spec['events'] = [{**behind, 'occluded_by': None}]      # the matte field alone still looks like a person cut-out
        self.assertIsNone(cutout_bottom.needs(ctx))
        ctx.spec['events'] = [behind]
        self.assertIsNotNone(cutout_bottom.needs(ctx))
        ctx.spec['events'] = [{k: v for k, v in behind.items() if k != 'occluded_by'}]      # declared on the render's timeline element instead
        ctx.timeline = {'elements': [{'id': 'q', 'at': 0.0, 'occluded_by': 'person_matte', 'matte': 'work/matte/q/matte'}]}
        self.assertIsNotNone(cutout_bottom.needs(ctx))
        ctx.spec['events'].append({'type': 'person_matte', 'id': 'p', 'at': 0.0})      # a real look-alike next to it is still not measured, not skipped
        self.assertIsNone(cutout_bottom.needs(ctx))

    def test_no_cutout_in_the_spec_skips_the_check(self):
        self.assertIsNotNone(cutout_bottom.needs(self.ctx(40, declared=False)))


class Bridge(Base):
    def ctx(self, spec_extra=None):
        write_video(self.path('p.mp4'), moving(24))
        add_audio(self.path('p.mp4'), np.zeros(16000 * 1))
        words = [('Not', 0.0, 0.2), ('quite.', 0.2, 0.5), ('Are', 1.0, 1.2), ('you?', 1.2, 1.4), ('She', 1.8, 1.9), ('weighs', 1.9, 2.4), ('pebbles.', 2.4, 2.8),
                 ('So', 3.0, 3.1), ('I', 3.1, 3.2), ('started.', 3.2, 3.6)]
        jsonio.write(self.path('w.json'), [{'w': w, 's': s, 'e': e} for w, s, e in words])
        jsonio.write(self.path('voice.json'), {'words': [{'text': 'x', 'start': 0.0, 'end': 2.9}]})
        spec = {'edit': {'overlay': {'at': 0}, 'preview': [0, 4.0]}, 'voice': {'words': self.path('voice.json'), 'start_s': 0.0}, **(spec_extra or {})}
        return ctx_for(self.tmp, self.path('p.mp4'), spec, words=self.path('w.json'), cache_dir=self.path('cache'))

    def run_with(self, answers, ctx=None):
        calls = []

        def fake(cfg, a, b):
            calls.append((a['who'], a['text'], b['who'], b['text']))
            return answers(a['text'], b['text'])
        real, bridge.ask = bridge.ask, fake
        try:
            return bridge.run(ctx or self.ctx()), calls
        finally:
            bridge.ask = real

    def test_sentences_are_labelled_by_the_voice_window_and_every_pair_is_asked(self):
        fs, calls = self.run_with(lambda a, b: {'changes': False, 'link': 'so'})
        self.assertEqual(len(calls), 3)
        self.assertEqual([c[0] for c in calls] + [calls[-1][2]], ['Narrator', 'Narrator', 'Narrator', 'Speaker'])
        self.assertEqual(verdict(fs), 'PASS')

    def test_a_jump_at_an_inserted_line_fails_and_a_bridge_passes(self):
        jump = lambda a, b: {'changes': b.startswith('She'), 'link': 'none', 'why': 'new subject'}
        fs, _ = self.run_with(jump)
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('inserted line', [f for f in fs if f.status == 'FAIL'][0].message)
        bridged = lambda a, b: {'changes': b.startswith('She'), 'link': 'What she actually does' if b.startswith('She') else 'none'}
        self.assertEqual(verdict(self.run_with(bridged)[0]), 'PASS')

    def test_a_pronoun_alone_is_not_a_bridge(self):
        fs, _ = self.run_with(lambda a, b: {'changes': b.startswith('She'), 'link': 'She', 'why': 'x'})
        self.assertEqual(verdict(fs), 'FAIL')

    def test_a_jump_inside_the_speakers_own_footage_is_a_note_not_a_failure(self):
        ctx = self.ctx({'voice': None})                                    # no inserted voice: every line is the speaker's own
        fs, _ = self.run_with(lambda a, b: {'changes': True, 'link': 'none', 'why': 'x'}, ctx)
        self.assertEqual(verdict(fs), 'PASS')
        self.assertTrue(any('script is theirs' in f.message for f in fs))

    def test_the_model_call_retries_with_backoff_and_a_failure_is_not_measured(self):
        cache = tempfile.mkdtemp()
        cfg = dict(limits()['bridge'], cache_dir=cache, attempts=3, backoff_s=0.5)
        pair = ({'who': 'Narrator', 'text': 'Retry unique one.'}, {'who': 'Speaker', 'text': 'Retry unique two.'})
        sleeps, calls = [], []

        def flaky(req, timeout):
            calls.append(timeout)
            if len(calls) < 3:
                raise OSError('timed out')

            class R:
                def read(self):
                    return json.dumps({'response': json.dumps({'changes': False, 'link': 'so', 'why': 'x'})}).encode()
            return R()
        real_open, real_sleep = bridge.urllib.request.urlopen, bridge.time.sleep
        bridge.urllib.request.urlopen, bridge.time.sleep = flaky, sleeps.append
        try:
            self.assertEqual(bridge.ask(cfg, *pair)['link'], 'so')
            self.assertEqual(sleeps, [0.5, 1.0])                                      # doubling backoff, one sleep per retry
            self.assertEqual(calls, [cfg['timeout_s']] * 3)
            self.assertEqual(bridge.ask(cfg, *pair)['link'], 'so')                    # the second time comes from the cache
            self.assertEqual(len(calls), 3)
            calls.clear(), sleeps.clear()
            dead = lambda req, timeout: (_ for _ in ()).throw(OSError('refused'))
            bridge.urllib.request.urlopen = dead
            self.assertIsNone(bridge.ask(cfg, {'who': 'Narrator', 'text': 'Retry unique three.'}, pair[1]))
            self.assertEqual(len(sleeps), 2)
        finally:
            bridge.urllib.request.urlopen, bridge.time.sleep = real_open, real_sleep
            shutil.rmtree(cache, ignore_errors=True)

    def test_no_model_is_not_measured(self):
        fs, _ = self.run_with(lambda a, b: None)
        self.assertEqual(verdict(fs), 'WARN')
        self.assertTrue(all(f.data['not_measured'] for f in fs))


if __name__ == '__main__':
    unittest.main()
