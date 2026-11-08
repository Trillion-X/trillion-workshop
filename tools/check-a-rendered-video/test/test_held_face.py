"""held-face: a hold must not freeze on a blink or half-closed eyes, nor (long) on a mouth caught mid-word. The face landmark reader (Apple Vision) is stubbed
with canned faces, so the verdict logic is tested on any computer. Run: python3 test/run_tests.py"""
import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import Base, FPS, ctx_for, write_video  # noqa: E402
from rendercheck.checks import held_face  # noqa: E402
from rendercheck.report import verdict  # noqa: E402


class HeldFace(Base):
    def ctx(self, hold=None, seconds=4):
        """A video of `seconds` that is one still picture (a hold plays a still), with the hold in the spec."""
        write_video(self.path('p.mp4'), [np.full((1080, 1920, 3), 90, np.uint8)] * int(FPS * seconds))
        edit = {'preview': [0, float(seconds)]}
        if hold is not False:
            edit['hold'] = hold or {'at': 0.0, 'seconds': float(seconds)}
        return ctx_for(self.tmp, self.path('p.mp4'), {'edit': edit, 'events': []})

    def still(self, name):
        path = self.path(name)
        cv2.imwrite(path, np.full((1080, 1920, 3), 90, np.uint8))
        return path

    def faces(self, eye, mouth=0.1):
        return lambda ctx, images: {images[0]: [{'box': [0.4, 0.5, 0.1, 0.2], 'eye_open': [eye, eye + 0.01], 'mouth_open': mouth}]}

    def run_with(self, ctx, reader):
        real, held_face.read_landmarks = held_face.read_landmarks, reader
        try:
            return held_face.run(ctx)
        finally:
            held_face.read_landmarks = real

    def test_eyes_under_the_threshold_fail_and_open_eyes_pass(self):
        fs = self.run_with(self.ctx(), self.faces(0.24))
        self.assertEqual(verdict(fs), 'FAIL')
        self.assertIn('eyes are 0.24 open', fs[0].message)
        self.assertEqual(verdict(self.run_with(self.ctx(), self.faces(0.36))), 'PASS')

    def test_a_long_hold_on_a_mid_word_mouth_warns_and_a_short_one_does_not(self):
        fs = self.run_with(self.ctx(), self.faces(0.36, mouth=0.6))
        self.assertEqual(verdict(fs), 'WARN')
        self.assertIn('mid-word', fs[0].message)
        short = self.ctx(hold={'at': 0.0, 'seconds': 1.0})
        self.assertEqual(verdict(self.run_with(short, self.faces(0.36, mouth=0.6))), 'PASS')

    def test_a_blink_on_a_very_short_flash_hold_is_not_judged_but_a_half_second_hold_is(self):
        self.assertEqual(verdict(self.run_with(self.ctx(hold={'at': 0.0, 'seconds': 0.3}), self.faces(0.1))), 'PASS')
        self.assertEqual(verdict(self.run_with(self.ctx(hold={'at': 0.0, 'seconds': 0.6}), self.faces(0.1))), 'FAIL')

    def test_no_face_or_no_reader_is_not_measured_never_a_pass(self):
        fs = self.run_with(self.ctx(), lambda ctx, images: {p: [] for p in images})
        self.assertEqual(verdict(fs), 'WARN')
        self.assertTrue(fs[0].data['not_measured'])
        fs = self.run_with(self.ctx(), lambda ctx, images: None)
        self.assertEqual(verdict(fs), 'WARN')
        self.assertIn('not available', fs[0].message)

    def test_without_a_landmarks_python_the_reader_is_not_available(self):
        ctx = self.ctx()
        env = os.environ.pop('LANDMARKS_PYTHON', None)
        try:
            self.assertIsNone(held_face.read_landmarks(ctx, [self.still('x.png')]))
            os.environ['LANDMARKS_PYTHON'] = self.path('no-such-python')
            self.assertIsNone(held_face.read_landmarks(ctx, [self.still('x.png')]))
        finally:
            os.environ.pop('LANDMARKS_PYTHON', None)
            if env is not None:
                os.environ['LANDMARKS_PYTHON'] = env

    def test_a_spec_with_no_hold_is_an_empty_set(self):
        self.assertTrue(held_face.needs(self.ctx(hold=False)).startswith(held_face.EMPTY_SET))
        self.assertIsNone(held_face.needs(self.ctx()))

    def test_a_still_laid_over_the_whole_frame_is_the_held_picture(self):
        ctx = self.ctx()
        still = self.still('open.png')
        ctx.spec['events'] = [{'type': 'hold_still', 'id': 'hs', 'image': still, 'covers_a_roll': True}]
        seen = []
        self.run_with(ctx, lambda c, images: seen.append(images) or {images[0]: []})
        self.assertEqual(seen[0], [still])

    def test_a_hold_picture_is_the_picture_shown_and_a_missing_file_is_not_measured(self):
        ctx = self.ctx(hold=False)
        still = self.still('open.png')
        ctx.edit['hold_picture'] = {'image': 'open.png', 'at': 0.0, 'seconds': 3.0}      # relative: beside the video, with no lane_root_regex match
        ctx.edit['hold'] = {'at': 0.0, 'seconds': 3.0}      # the footage hold stays as it is; the still plays over it
        seen = []
        fs = self.run_with(ctx, lambda c, images: seen.append(images) or {images[0]: [{'box': [0.4, 0.5, 0.1, 0.2], 'eye_open': [0.36, 0.37], 'mouth_open': 0.1}]})
        self.assertEqual(seen[0], [still])
        self.assertEqual(verdict(fs), 'PASS')
        self.assertIn('hold_picture still', fs[0].message)
        ctx.edit['hold_picture']['image'] = 'nowhere.png'
        fs = self.run_with(ctx, self.faces(0.36))
        self.assertEqual(verdict(fs), 'WARN')
        self.assertIn('not on disk', fs[0].message)

    def test_the_hold_is_placed_by_the_video_start(self):
        ctx = self.ctx(hold={'at': 12.0, 'seconds': 2.0}, seconds=4)
        ctx.edit['preview'] = [11.0, 15.0]
        ctx.p0 = 11.0
        self.assertEqual(held_face.holds(ctx), [(1.0, 2.0, None)])

    def test_each_of_several_holds_is_judged_on_its_own_picture(self):
        ctx = self.ctx(hold=[{'at': 2.0, 'seconds': 0.5}, {'at': 0.5, 'seconds': 0.5}], seconds=4)      # unsorted, as a spec may list them
        open_still, shut_still = self.still('open.png'), self.still('shut.png')
        ctx.edit['hold_picture'] = [{'image': shut_still, 'at': 2.5, 'seconds': 0.5}, {'image': open_still, 'at': 0.5, 'seconds': 0.5}]      # final times: 0.5 and 2.0 + 0.5
        self.assertEqual([(s, secs, p['image']) for s, secs, p in held_face.holds(ctx)], [(0.5, 0.5, open_still), (2.5, 0.5, shut_still)])
        fs = self.run_with(ctx, lambda ctx, images: {images[0]: [{'box': [0.4, 0.5, 0.1, 0.2], 'eye_open': [0.1 if images[0] == shut_still else 0.4] * 2, 'mouth_open': 0.1}]})
        self.assertEqual([(f.status, f.t) for f in fs], [('INFO', 0.5), ('FAIL', 2.5)])

    def test_with_base_footage_the_hold_reads_the_base_at_its_source_second(self):
        ctx = self.ctx(hold={'at': 1.0, 'seconds': 1.0})
        write_video(self.path('base.mp4'), [np.full((1080, 1920, 3), 60, np.uint8)] * (FPS * 4))
        ctx.cfg['placement']['bases'] = {r'p\.mp4$': [{'file': 'base.mp4', 'from': 0.0, 'to': 4.0}]}
        seen = []
        fs = self.run_with(ctx, lambda c, images: seen.append(images) or {images[0]: [{'box': [0.4, 0.5, 0.1, 0.2], 'eye_open': [0.4, 0.4], 'mouth_open': 0.1}]})
        self.assertEqual(len(seen[0]), 1)
        self.assertIn('base footage at source second 1.00', fs[0].message)
        ctx.cfg['placement']['bases'] = {r'p\.mp4$': [{'file': 'gone.mp4', 'from': 0.0, 'to': 4.0}]}
        fs = self.run_with(ctx, self.faces(0.4))
        self.assertEqual(verdict(fs), 'WARN')
        self.assertTrue(fs[0].data['unreached'])


# Vision helper output is checked here alongside its existing held-face consumer.
# Native bindings are replaced; these checks do not run a detector or render video.
import contextlib
import importlib.util
import io
import json
import types
from unittest.mock import patch


class Region:
    def __init__(self, points):
        self.points = [types.SimpleNamespace(x=x, y=y) for x, y in points]

    def normalizedPoints(self):
        return self.points

    def pointCount(self):
        return len(self.points)


class Landmarks:
    def __init__(self, left, right, mouth):
        self.regions = left, right, mouth

    def leftEye(self):
        return self.regions[0]

    def rightEye(self):
        return self.regions[1]

    def innerLips(self):
        return self.regions[2]


class Face:
    def __init__(self, landmarks, box=(0.2, 0.25, 0.5, 0.5)):
        self.lm = landmarks
        self.box = types.SimpleNamespace(origin=types.SimpleNamespace(x=box[0], y=box[1]), size=types.SimpleNamespace(width=box[2], height=box[3]))

    def landmarks(self):
        return self.lm

    def boundingBox(self):
        return self.box


class Request:
    found = []

    @classmethod
    def alloc(cls):
        return cls()

    def init(self):
        return self

    def results(self):
        return self.found


class Handler:
    ok = True
    inputs = []

    @classmethod
    def alloc(cls):
        return cls()

    def initWithURL_options_(self, url, options):
        self.inputs.append(('url', url, options))
        return self

    def initWithCGImage_options_(self, image, options):
        self.inputs.append(('cg_image', image, options))
        return self

    def performRequests_error_(self, requests, error):
        return self.ok, None


vision = types.SimpleNamespace(VNDetectFaceLandmarksRequest=Request, VNImageRequestHandler=Handler)
foundation = types.SimpleNamespace(NSURL=types.SimpleNamespace(fileURLWithPath_=lambda path: path))
path = os.path.join(os.path.dirname(__file__), '..', 'do-work', 'rendercheck', 'vision_landmarks.py')
spec = importlib.util.spec_from_file_location('vision_landmarks_under_test', path)
helper = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'Vision': vision, 'Foundation': foundation}):
    spec.loader.exec_module(helper)


def contours():
    return Landmarks(Region([(0, 0.1), (0.2, 0.3), (0.4, 0.1)]), Region([(0, 0.1), (0.2, 0.2), (0.4, 0.1)]), Region([(0.1, 0.1), (0.3, 0.4), (0.5, 0.1)]))


class VisionLandmarks(unittest.TestCase):
    def setUp(self):
        Request.found = [Face(contours())]
        Handler.ok = True
        Handler.inputs = []
        self.image = object()
        self.owner = object()
        self.decoded = self.image, (1000, 600), self.owner

    def output(self, argv):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            helper.main(argv)
        return stream.getvalue()

    def test_empty_regions_do_not_crash_and_default_two_point_ratio_stays_available(self):
        self.assertIsNone(helper._openness([]))
        self.assertIsNone(helper._openness([(0.2, 0), (0.2, 0.1), (0.2, 0.2)]))
        self.assertEqual(helper._openness([(0, 0), (0.5, 0.25)]), 0.5)
        self.assertIsNone(helper._openness([(0, 0), (0.5, 0.25)], minimum_points=3))

    def test_default_json_keeps_all_faces_and_the_original_fields(self):
        Request.found.append(Face(Landmarks(None, None, None)))
        answer = json.loads(self.output(['sample.png']))['sample.png']
        self.assertEqual(len(answer), 2)
        self.assertEqual(set(answer[0]), {'box', 'eye_open', 'mouth_open'})
        self.assertEqual(answer[0]['box'], [0.2, 0.25, 0.5, 0.5])
        self.assertAlmostEqual(answer[0]['eye_open'][0], 0.5)
        self.assertAlmostEqual(answer[0]['eye_open'][1], 0.25)
        self.assertAlmostEqual(answer[0]['mouth_open'], 0.75)
        self.assertEqual(answer[1]['eye_open'], [None, None])
        self.assertIsNone(answer[1]['mouth_open'])
        self.assertEqual(Handler.inputs, [('url', 'sample.png', None)])
        Request.found = [Face(None)]
        no_landmarks = json.loads(self.output(['sample.png']))['sample.png'][0]
        self.assertEqual(set(no_landmarks), {'box', 'eye_open', 'mouth_open'})
        self.assertEqual(no_landmarks['eye_open'], [None, None])
        self.assertIsNone(no_landmarks['mouth_open'])
        Request.found = []
        self.assertEqual(json.loads(self.output(['sample.png'])), {'sample.png': []})
        self.assertEqual(json.loads(self.output([])), {})

    def test_text_reuses_first_face_and_reports_top_left_pixel_coordinates(self):
        Request.found.append(Face(contours(), box=(0, 0, 1, 1)))
        with patch.object(helper, '_image_for_text', return_value=self.decoded), patch.object(helper, 'faces', wraps=helper.faces) as read:
            answer = self.output(['--output', 'text', '/made/up/sample.png'])
        self.assertEqual(answer, 'sample.png eyes 0.375 (L 0.500 R 0.250) mouth 0.750 box 200 150 500 300\n')
        read.assert_called_once_with('/made/up/sample.png', include_regions=True, cg_image=self.image)
        self.assertEqual(Handler.inputs, [('cg_image', self.image, {})])

    def test_missing_and_short_regions_keep_negative_sentinels_in_the_mean(self):
        Request.found = [Face(Landmarks(None, contours().rightEye(), None))]
        found = helper.faces('sample.png', include_regions=True)
        self.assertEqual(helper._text_line('sample.png', found, (1000, 600)), 'sample.png eyes -0.375 (L -1.000 R 0.250) mouth -1.000 box 200 150 500 300')
        Request.found = [Face(Landmarks(Region([(0, 0), (1, 1)]), Region([(0, 0), (0, 1), (0, 2)]), None))]
        found = helper.faces('sample.png', include_regions=True)
        self.assertIn('eyes -1.000 (L -1.000 R -1.000) mouth -1.000', helper._text_line('sample.png', found, (1000, 600)))

    def test_no_face_or_first_face_without_landmarks_does_not_select_a_later_face(self):
        for observed in ([], [Face(None), Face(contours())]):
            Request.found = observed
            with patch.object(helper, '_image_for_text', return_value=self.decoded):
                self.assertEqual(self.output(['--output', 'text', '/made/up/sample.png']), 'sample.png no face\n')
        Request.found = [Face(Landmarks(None, None, None))]
        self.assertIn('eyes -1.000', helper._text_line('sample.png', helper.faces('sample.png', include_regions=True), (1000, 600)))

    def test_unreadable_uses_full_path_and_vision_failure_keeps_default_json_failure(self):
        with patch.object(helper, '_image_for_text', return_value=None), patch.object(helper, 'faces') as read:
            self.assertEqual(self.output(['--output', 'text', '/made/up/bad.png']), '/made/up/bad.png unreadable\n')
            read.assert_not_called()
        Handler.ok = False
        with self.assertRaises(SystemExit):
            self.output(['sample.png'])
        with patch.object(helper, '_image_for_text', return_value=self.decoded):
            self.assertEqual(self.output(['--output', 'text', '/made/up/sample.png']), 'sample.png no face\n')

    def test_appkit_decode_supplies_the_same_image_and_its_pixel_dimensions(self):
        image = object()
        null = object()
        owner = unittest.mock.Mock()
        ns_image = unittest.mock.Mock()
        ns_image.alloc.return_value.initWithContentsOfFile_.return_value = owner
        quartz = types.SimpleNamespace(CGImageGetWidth=lambda value: 2000 if value is image else 0, CGImageGetHeight=lambda value: 1200 if value is image else 0)
        with patch.dict(sys.modules, {'AppKit': types.SimpleNamespace(NSImage=ns_image), 'objc': types.SimpleNamespace(NULL=null), 'Quartz': quartz}):
            for returned in (image, (image, None)):
                owner.CGImageForProposedRect_context_hints_.return_value = returned
                self.assertEqual(helper._image_for_text('sample.png'), (image, (2000, 1200), owner))
                owner.CGImageForProposedRect_context_hints_.assert_called_with(null, None, None)
            ns_image.alloc.return_value.initWithContentsOfFile_.assert_called_with('sample.png')
            owner.CGImageForProposedRect_context_hints_.return_value = None
            self.assertIsNone(helper._image_for_text('sample.png'))
            ns_image.alloc.return_value.initWithContentsOfFile_.return_value = None
            self.assertIsNone(helper._image_for_text('sample.png'))


if __name__ == '__main__':
    unittest.main()
