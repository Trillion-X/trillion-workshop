"""The cutter's tests, on made-up data only: pure readers first, then real ffmpeg runs on recordings drawn by ffmpeg, with a
stand-in renderer, face reader, checker and speaker (test/fixtures). Run: python3 test/run_tests.py"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / 'do-work'), str(HERE.parent / 'read-data')]

import cut  # noqa: E402
import graphics  # noqa: E402
import media  # noqa: E402
import plans  # noqa: E402
from fill import Refused, bind, fill  # noqa: E402
from fixture_world import FIX, PY, make_world, pieces, request, run_tool  # noqa: E402
from plan_pieces import aspects_of, is_slides, pieces_of, span_key  # noqa: E402
from timing import caption_chunks, shifted, times_of, word_times  # noqa: E402

TABLE = {'default': {'hook': {'piece': 'clip'}, 'reply': {'piece': 'clip'}, 'ask': {'piece': 'voiced_line', 'tag': 'made-up tag'}, 'note': {'piece': 'skip'}},
         'formats': {'format_a': {}, 'format_b': {'note': {'piece': 'clip'}}}, 'aspects_by_medium': {'film': ['16:9 640x360'], 'tall': ['9:16 360x640']}}
FIELDS = {'keys': ['at', 'out', 'ready_at'], 'suffix': '_at', 'lists': ['times', 'hits']}


def plan(option, kinds):
    return {'slug': 'made-up', 'format': {'option': option}, 'segments': [{'kind': k} for k in kinds]}


class Pieces(unittest.TestCase):
    def test_a_format_row_overlays_the_default(self):
        self.assertEqual(pieces_of(plan('format_a', ['hook', 'note']), TABLE)['note']['piece'], 'skip')
        self.assertEqual(pieces_of(plan('format_b', ['hook', 'note']), TABLE)['note']['piece'], 'clip')

    def test_a_format_with_no_row_and_an_unnamed_kind_are_refused(self):
        with self.assertRaisesRegex(Refused, 'format format_c is not renderable yet'):
            pieces_of(plan('format_c', ['reply']), TABLE)
        with self.assertRaisesRegex(Refused, 'segment kind page has no piece for format format_a'):
            pieces_of(plan('format_a', ['reply', 'page']), TABLE)

    def test_a_piece_the_cutter_does_not_make_is_refused(self):
        odd = {**TABLE, 'formats': {'format_a': {'hook': {'piece': 'hologram'}}}}
        with self.assertRaisesRegex(Refused, 'piece hologram is not one the cutter makes'):
            pieces_of(plan('format_a', ['hook']), odd)

    def test_aspects_follow_the_medium_and_the_plan_may_add_more(self):
        p = {'format': {'medium': 'tall', 'aspects_also': ['16:9 640x360']}}
        self.assertEqual(aspects_of(p, TABLE), [('9:16 360x640', 360, 640), ('16:9 640x360', 640, 360)])
        with self.assertRaisesRegex(Refused, 'medium radio has no aspects'):
            aspects_of({'slug': 'x', 'format': {'medium': 'radio'}}, TABLE)

    def test_a_plan_is_all_slides_or_all_film(self):
        table = pieces()
        deck = {'slug': 'd', 'format': {'option': 'deck'}, 'segments': [{'kind': 'page'}]}
        self.assertTrue(is_slides(deck, pieces_of(deck, table)))
        mixed = {**deck, 'format': {'option': 'deck'}, 'segments': [{'kind': 'page'}, {'kind': 'reply'}]}
        with self.assertRaisesRegex(Refused, 'mix stills and cuts'):
            is_slides(mixed, pieces_of(mixed, table))

    def test_the_span_key_is_clip_from_to(self):
        self.assertEqual(span_key({'clip': 'take-one', 'from': 1.0, 'to': 2.345}), 'take-one_1.00_2.35')


class Templates(unittest.TestCase):
    def test_fill_by_side_join_each_if_on_side_and_why(self):
        t = {'a': {'fill': 'x'}, 'b': {'by_side': {'left': 1, 'right': 2}}, 'c': {'join': ['n', {'fill': 'x'}]}, 'd': ['--s', {'each': 'xs'}],
             'e': {'if': 'gone', 'then': 1}, 'f': {'if': 'x', 'then': {'fill': 'x'}}, 'on_side': {'left': {'pos': 1}, 'right': {'end': 2}}, 'why': 'note',
             'g': {'inner': {'why': 'deep note', 'k': 3}}}
        self.assertEqual(fill(t, {'x': 5, 'xs': [1, 2], 'gone': None}, 'right'),
                         {'a': 5, 'b': 2, 'c': 'n5', 'd': ['--s', 1, 2], 'f': 5, 'end': 2, 'g': {'inner': {'k': 3}}})

    def test_a_template_naming_an_unmeasured_value_is_refused(self):
        with self.assertRaisesRegex(Refused, 'names "nothing"'):
            fill({'a': {'fill': 'nothing'}}, {'x': 1})

    def test_bind_reads_paths_and_values_from_their_owners(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / '.git').mkdir()
            (base / 'sub').mkdir()
            (base / 'owner.json').write_text(json.dumps({'checker': {'line': 7, 'file': {'here': 'sub/f.txt'}}}))
            req = {'p': {'here': 'sub/a.json'}, 'w': {'workshop': 'tools/x'}, 'r': {'repository': 'owner.json'},
                   'n': {'read_json': {'repository': 'owner.json'}, 'at': ['checker', 'line']}, 'whole': {'read_json': {'repository': 'owner.json'}}}
            out = bind(req, str(base / 'sub'), '/workshop-root')
            self.assertEqual(out['p'], str(base / 'sub' / 'sub' / 'a.json'))
            self.assertEqual(out['w'], '/workshop-root/tools/x')
            self.assertEqual(out['r'], str(base / 'owner.json'))
            self.assertEqual(out['n'], 7)
            self.assertEqual(out['whole']['checker']['file'], str(base / 'sub' / 'f.txt'))
            with self.assertRaisesRegex(Refused, r'has no \[.checker., .nope.\]'):
                bind({'n': {'read_json': {'repository': 'owner.json'}, 'at': ['checker', 'nope']}}, str(base / 'sub'), '/w')


class Times(unittest.TestCase):
    def test_every_time_at_any_depth_moves_and_nothing_else_does(self):
        e = {'type': 'made-up', 'at': 12.0, 'release_at': 18.0, 'pos': [60, 40], 'w': 620, 'fade_s': 0.4,
             'layers': [{'text': 'a', 'at': 13.0, 'px': 28}], 'floor': {'at': 15.0, 'hits': [15.2, 15.6]}, 'stamps_at': [13.0, 14.0],
             'lit': {'times': [12.1, 12.2], 'dim': 0.75}, 'words_at': ['word', 0.2]}
        s = shifted(e, -10.0, FIELDS)
        self.assertEqual((s['at'], s['release_at'], s['layers'][0]['at'], s['floor']['at'], s['floor']['hits']), (2.0, 8.0, 3.0, 5.0, [5.2, 5.6]))
        self.assertEqual((s['pos'], s['w'], s['fade_s'], s['layers'][0]['px'], s['lit']['dim']), ([60, 40], 620, 0.4, 28, 0.75))
        self.assertEqual((s['stamps_at'], s['lit']['times'], s['words_at']), ([3.0, 4.0], [2.1, 2.2], ['word', 0.2]))
        self.assertEqual(max(times_of(s, FIELDS)), 8.0)

    def test_shown_words_take_the_heard_times(self):
        heard = [{'text': 'What', 'start': 0.3, 'end': 0.5}, {'text': 'is', 'start': 0.6, 'end': 0.7}, {'text': 'this?', 'start': 0.8, 'end': 1.1}]
        self.assertEqual(word_times(['What', 'is', 'this?'], heard, 2.0), [0.3, 0.6, 0.8])
        self.assertEqual(word_times(['What', 'new', 'is', 'this?'], heard, 2.0), [0.3, 0.45, 0.6, 0.8])

    def test_captions_break_after_stops_never_after_a_dangling_word(self):
        rules = {'aim_words': 4, 'min_words': 2, 'min_s': 0.1, 'max_words': 5, 'dangling_words': ['and'], 'clause_words': [], 'stops': '.?!', 'commas': ',;:',
                 'cost': {'after_stop': 0, 'after_comma': 1, 'before_clause': 2, 'elsewhere': 6, 'after_dangling': 100, 'per_word_off_aim': 0.1, 'short': 50}}
        words = [{'text': w, 'start': k * 0.3, 'end': k * 0.3 + 0.2} for k, w in enumerate('one two three four. five six and seven eight.'.split())]
        chunks = [' '.join(w['text'] for w in c) for c in caption_chunks(words, rules)]
        self.assertEqual(chunks, ['one two three four.', 'five six and seven eight.'])
        self.assertEqual(caption_chunks(words, {**{k: v for k, v in rules.items() if k != 'max_words'}, 'dense_words': 4, 'room_words': 1})[0][-1]['text'], 'three')


class SpanSound(unittest.TestCase):
    """the grade row decides a span's sound: the source only when as-is, else its graded file; a missing row or file stops the cut"""
    seg = {'clip': 'take-one', 'from': 10.0, 'to': 20.0}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        folder = Path(self.tmp.name)
        (folder / 'p.json').write_text(json.dumps({'slug': 'p', 'format': {'option': 'chain'}, 'segments': []}))
        (folder / 'p').mkdir()
        self.p = cut.Plan({'pieces': pieces(), 'grades': {'file': 'grades.json', 'as_is': 'kept', 'recreated_key': 'made'}}, folder / 'p.json')
        self.sid = span_key(self.seg)

    def tearDown(self):
        self.tmp.cleanup()

    def test_as_is_plays_the_source_and_a_graded_span_its_file(self):
        self.assertEqual(self.p.span_audio(self.seg, {self.sid: {'treatment': 'kept'}}, 'cam.mp4'), ('cam.mp4', 0.0))
        (self.p.folder / 'fixed.wav').write_bytes(b'made-up')
        got = self.p.span_audio(self.seg, {self.sid: {'treatment': 'fixed', 'audio': 'fixed.wav', 'audio_from': 9.85}}, 'cam.mp4')
        self.assertEqual(got, (str(self.p.folder / 'fixed.wav'), 9.85))
        self.assertTrue(self.p.recreated(self.seg, {self.sid: {'made': True}}))

    def test_no_row_or_a_missing_graded_file_stops_the_cut(self):
        with self.assertRaisesRegex(Refused, f'span {self.sid} has no row'):
            self.p.span_audio(self.seg, {}, 'cam.mp4')
        with self.assertRaisesRegex(Refused, 'is missing'):
            self.p.span_audio(self.seg, {self.sid: {'treatment': 'fixed', 'audio': 'gone.wav', 'audio_from': 9.85}}, 'cam.mp4')
        self.assertEqual(self.p.span_audio(self.seg, None, 'cam.mp4'), ('cam.mp4', 0.0))


class PlanSteps(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        segs = [{'kind': 'reply', 'clip': 'a', 'from': 0, 'to': 2, 'text': 'x', 'label': 'old'}, {'kind': 'reply', 'clip': 'b', 'from': 1, 'to': 4, 'text': 'y'},
                {'kind': 'note', 'clip': None, 'from': None, 'to': None, 'text': 'Then: Old Name'}]
        (self.folder / 'p1.json').write_text(json.dumps({'slug': 'p1', 'id': 'X1', 'title': 'Old Name', 'segments': segs}))
        (self.folder / 'p2.json').write_text(json.dumps({'slug': 'p2', 'id': 'X2', 'title': 'Second', 'segments': []}))

    def tearDown(self):
        self.tmp.cleanup()

    def test_regroup_builds_lead_and_members_and_uses_every_clip_once(self):
        shape = {'groups': [{'lead': {'kind': 'ask', 'clip': None, 'text': 'A made-up lead?'}, 'members': [1, 0], 'member_kind': 'reply', 'labels': {'0': 'new'}}],
                 'tail': [2]}
        out = plans.regroup({'plans_folder': str(self.folder), 'shapes': {'p1': shape}, 'structure': 'made-up note'})
        p = json.loads((self.folder / 'p1.json').read_text())
        self.assertEqual([s['kind'] for s in p['segments']], ['ask', 'reply', 'reply', 'note'])
        self.assertEqual([s.get('label') for s in p['segments']], [None, None, 'new', None])
        self.assertEqual((p['structure'], out['plans'][0]['group_seconds']), ('made-up note', [5]))
        with self.assertRaisesRegex(Refused, 'used exactly once'):
            plans.regroup({'plans_folder': str(self.folder), 'shapes': {'p1': {'groups': [{'lead': {}, 'members': [1], 'member_kind': 'reply'}]}}})

    def test_retitle_renames_titles_and_the_cards_that_name_them(self):
        titles = {'titles': [{'id': 'X1', 'title': 'New Name', 'basis': 'given'}, {'id': 'X2', 'title': 'placeholder', 'basis': 'none'}], 'card_state': 'held'}
        out = plans.retitle({'plans_folder': str(self.folder), 'titles': titles, 'untitled': ['placeholder'], 'card_kind': 'note', 'card_prefixes': ['Then: '],
                             'copy_from_row': ['basis'], 'copy_from_doc': ['card_state']})
        p1, p2 = (json.loads((self.folder / f'{n}.json').read_text()) for n in ('p1', 'p2'))
        self.assertEqual((p1['title'], p1['segments'][2]['text'], p1['basis'], p1['card_state']), ('New Name', 'Then: New Name', 'given', 'held'))
        self.assertEqual((p2['title'], p2['withdrawn_title']), ('placeholder', 'Second'))
        self.assertEqual([r['title'] for r in out['plans']], ['New Name', 'placeholder'])

    def test_outline_numbers_the_segments(self):
        out = plans.outline({'plan_files': [str(self.folder / 'p1.json')]})['plans'][0]
        self.assertEqual((out['recorded_seconds'], [r['i'] for r in out['segments']]), (5, [0, 1, 2]))

    def test_timelines_compare_field_by_field(self):
        a = [{'seg': 0, 'kind': 'k', 'text': 't', 'start': 0.0, 'dur': 1.0}]
        self.assertTrue(cut.compare_timelines(a, a)['same'])
        b = [{**a[0], 'dur': 1.5}]
        self.assertEqual(cut.compare_timelines(a, b)['differences'], [{'seg': 0, 'field': 'dur', 'before': 1.0, 'now': 1.5}])


class Notes(unittest.TestCase):
    def test_the_renderer_merges_segment_notes_by_its_rule(self):
        r = graphics.Renderer({**request(make_world_paths())['overlay_renderer']}, cut.rules_of({}, (640, 360)))
        specs = [{'notes': {'a': 1}, 'moves': {'m': 'x'}, 'purpose': 'p'}, {'notes': {'a': 1}, 'moves': {'m': 'y'}, 'purpose': 'p'}]
        self.assertEqual(r.merge_notes(specs, 'n'), {'notes': {'a': 1}, 'moves': {'m': 'y'}, 'purpose': 'p'})
        with self.assertRaisesRegex(Refused, 'one value per notes key'):
            r.merge_notes([{'notes': {'a': 1}}, {'notes': {'a': 2}}], 'n')


def make_world_paths():
    root = Path(tempfile.mkdtemp(prefix='assemble-paths-'))
    return {'root': root, 'plans': root / 'plans', 'voice': root / 'voice', 'words': root / 'words', 'media': root / 'media'}


class Shots(unittest.TestCase):
    """a held frame takes the shot match of the span of its clip that holds it, else that clip's nearest span"""

    def test_a_held_frame_outside_every_span_takes_its_clips_nearest(self):
        spans = {3: ('A', 10.0, 20.0), 7: ('A', 40.0, 50.0), 9: ('B', 0.0, 5.0)}
        self.assertEqual([cut.shot_of(spans, 'A', t) for t in (15.0, 38.0, 21.0)], [3, 7, 3])
        self.assertIsNone(cut.shot_of(spans, 'C', 1.0))

    def test_a_look_is_a_filter_chain_from_data(self):
        self.assertEqual(media.filter_chain([{'filter': 'lut3d', 'options': {'file': '/a b/c.cube'}}, {'filter': 'eq', 'options': {'gamma': 1.1}}]),
                         'lut3d=file=/a b/c.cube,eq=gamma=1.1')
        self.assertEqual(media.filter_chain([{'filter': 'lut3d', 'options': {'file': '/a:b.cube'}}]), "lut3d=file='/a:b.cube'")


class World(unittest.TestCase):
    """the tool run for real on the made-up world"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.world = make_world(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def fresh(self, name, **kw):
        req = request(self.world, **kw)
        base = Path(self.tmp.name) / name
        req['folders'] = {'work': str(base / 'work'), 'seen': str(base / 'seen'), 'specs': str(base / 'specs'), 'holds_log': str(base / 'seen' / 'holds.json')}
        (base / 'work').mkdir(parents=True, exist_ok=True)
        return req

    def test_1_voice_lines_makes_each_missing_take_once(self):
        req = self.fresh('voice')
        code, out = run_tool('voice-lines', req)
        self.assertEqual(code, 0, out)
        self.assertEqual((out['result']['lines'], len(out['result']['made'])), (1, 1))
        take = Path(out['result']['made'][0]['take'])
        self.assertEqual(take.with_suffix('.txt').read_text(), 'What is the made-up question?')
        self.assertEqual(len(take.stem), 16)
        code, again = run_tool('voice-lines', req)
        self.assertEqual((again['result']['had'], again['result']['made']), (1, []))

    def test_2_build_makes_the_cut_checks_it_and_moves_it(self):
        req = self.fresh('build')
        run_tool('voice-lines', req)
        code, timeline = run_tool('timeline', req, 'chain-fixture')
        self.assertEqual(code, 0, timeline)
        code, out = run_tool('build', req, 'chain-fixture')
        self.assertEqual(code, 0, out)
        made = out['result']
        type(self).built = made['cut']
        self.assertTrue(Path(made['cut']).is_file())
        self.assertAlmostEqual(made['seconds_made'], timeline['result']['seconds'], delta=0.1)
        self.assertEqual(json.loads(Path(made['timeline']).read_text()), timeline['result']['timeline'])
        self.assertEqual([r['kind'] for r in timeline['result']['timeline']], ['opening', 'ask', 'reply', 'reply', 'reply'])
        self.assertEqual([c['id'] for c in made['checks'] if c['passed']], ['first-check'])
        self.assertEqual([h['open_eyed'] for h in made['holds']], [True])
        spec = json.loads(Path(made['spec']).read_text())
        self.assertEqual(spec['id'], 'chain-fixture')
        self.assertIn('voice', spec)
        ids = [e.get('id') for e in spec['events']]
        self.assertIn('q01-t-lit-asker', ids)
        self.assertIn('s02-t-lit-part', ids)
        self.assertTrue(any(i and i.startswith('s04-t-lit-c') for i in ids), ids)
        leave = next(e for e in spec['events'] if e['type'] == 'leave')
        self.assertEqual(leave['targets'], ['s02-t-lit-part'])
        self.assertTrue(all('why' not in e for e in spec['events']))
        self.assertEqual(spec['notes'], {'leave': 2, 'drop': 1})
        self.assertEqual(json.loads((Path(req['folders']['seen']) / 'holds.json').read_text())['chain-fixture'][0]['seg'], 1)
        self.edit_is_one_media_composition_edit(json.loads(Path(made['edit']).read_text()), timeline['result']['timeline'])

    def edit_is_one_media_composition_edit(self, edit, timeline):
        """the cut was rendered from one edit: a clip per segment at its frame count, the recorded spans graded by their look and the
        shot match, the held frames and the borrowed still matched like their shots, every sound a placement, one overlay layer"""
        clips = edit['spine']['segments']
        self.assertEqual(len(clips), len(timeline))
        fr = 1001 / 24000
        self.assertEqual([round(c['frames'] * fr, 4) for c in clips if 'still' not in c or 'ken_burns' in c],
                         [r['dur'] for r in timeline if r['kind'] != 'ask'])
        opening, ask, first, second, memo = clips
        self.assertTrue(all('shot_match' not in c for c in clips))
        self.assertTrue(all(c['reframe'] == {'fill_mode': 'black'} for c in clips))
        self.assertRegex(opening['grade'], r'^lut3d=file=.*/grade/00\.cube$')
        self.assertRegex(first['grade'], r'^eq=saturation=1\.1,lut3d=file=.*/grade/02\.cube$')
        self.assertEqual((ask['still']['at'] >= 0, ask['grade']), (True, first['grade']), 'the held frame is of the next span, in its look')
        self.assertEqual(memo['ken_burns'], {'zoom_from': 1, 'zoom_to': 1.04})
        self.assertTrue(first['muted'] and second['muted'])
        sounds = edit['audio_graph']['narration']
        self.assertEqual(len(sounds), 6, 'four spans, the voiced line and the overlay sound')
        self.assertEqual(sounds[0]['level'], {'lufs': -16.0, 'gain_db': [-12.0, 14.0]})
        self.assertEqual(sounds[0]['audio_filters'], 'alimiter=limit=0.89')
        self.assertEqual(sounds[1]['start'], timeline[1]['start'])
        self.assertTrue(edit['video_overlays'][0]['source_path'].endswith('overlay.mov'))
        self.assertEqual((edit['master_loudnorm'], edit['master_true_peak_dbfs'], edit['master_loudnorm_linear']), (-16, -1.5, True))

    def test_3_a_failed_check_keeps_the_cut_out_of_the_seen_folder(self):
        failing = [{'id': 'strict-check', 'argv': [PY, str(FIX / 'fake_checker.py'), '1', 'FAIL made-up fault', {'fill': 'cut'}], 'fail_line_contains': 'FAIL'}]
        req = self.fresh('gate', checks=failing)
        run_tool('voice-lines', req)
        code, out = run_tool('build', req, 'chain-fixture')
        self.assertEqual(code, 1)
        self.assertIn('strict-check did not pass', out['error'])
        self.assertIn('FAIL made-up fault', out['error'])
        self.assertFalse((Path(req['folders']['seen']) / 'chain-fixture.mp4').exists())
        self.assertTrue((Path(req['folders']['work']) / 'chain-fixture' / 'chain-fixture.mp4').is_file())

    def test_4_slides_become_pictures_and_a_pdf(self):
        req = self.fresh('slides')
        code, out = run_tool('build', req, 'deck-fixture')
        self.assertEqual(code, 0, out)
        made = out['result']
        self.assertEqual(len(made['slides']), 3)
        self.assertTrue(Path(made['pdf']).is_file())
        spec = json.loads((Path(req['folders']['work']) / 'deck-fixture' / 'gfx' / 'specs' / 'slide02-t-1.json').read_text())
        self.assertEqual((spec['frame'], spec['events'][0]['fit_with']), ([400, 500], ['First made-up page.', 'Second made-up page.']))

    def test_5_run_checks_each_plan_first_and_skips_formats_with_no_row(self):
        req = self.fresh('run')
        req['plan_checks'] = [{'id': 'plan-look', 'argv': [PY, str(FIX / 'fake_checker.py'), '2', 'unsure', {'fill': 'plan_file'}], 'advisory_exit_codes': [2]}]
        code, out = run_tool('run', req, 'deck-fixture', 'other-fixture')
        self.assertEqual(code, 0, out)
        status = {p['slug']: p['status'] for p in out['result']['plans']}
        self.assertEqual(status, {'deck-fixture': 'slides', 'other-fixture': 'format not renderable'})
        req['plan_checks'][0]['advisory_exit_codes'] = []
        code, out = run_tool('run', req, 'deck-fixture')
        self.assertEqual(out['result']['plans'][0]['status'], 'plan check stopped it')

    def test_6_plan_graphics_move_to_the_segment_and_away_from_the_face(self):
        rules = cut.rules_of({}, (640, 360))
        req = request(self.world)
        r = graphics.Renderer(req['overlay_renderer'], rules)
        g = graphics.Graphics(req['devices'], r, graphics.faces.FaceReader(req['face_reader']), rules)
        seg = {'clip': 'take-one', 'from': 2.0, 'to': 8.0, 'graphics': [
            {'type': 'sheet', 'id': 'sheet', 'times': 'source', 'pos': [20, 30], 'w': 200, 'h': 80, 'at': 3.0, 'out': 5.0, 'enter': 'left', 'why': 'made-up'}]}
        with tempfile.TemporaryDirectory() as tmp:
            (e,), end = g.plan_graphics(seg, 1.9, str(self.world['media'] / 'take-one.mp4'), media.fitted('', rules), False, Path(tmp), '00')
        self.assertEqual((e['at'], e['out'], e['enter']), (1.1, 3.1, 'right'))
        self.assertEqual(e['pos'], [419, 30])   # mirrored over the columns the stand-in drew: 20 .. 221
        self.assertNotIn('why', e)
        self.assertAlmostEqual(end, 3.1 + 1.0)

    def test_7_string_together_puts_a_card_between_cuts(self):
        req = self.fresh('reel')
        cut_file = getattr(type(self), 'built', None)
        if cut_file is None:
            run_tool('voice-lines', req)
            code, out = run_tool('build', req, 'chain-fixture')
            self.assertEqual(code, 0, out)
            cut_file = out['result']['cut']
        reel = {'films': [{'file': cut_file, 'label': 'first', 'card_text': ''}, {'file': cut_file, 'label': 'second', 'card_text': 'next one'},
                          {'file': '/no/such/file.mp4', 'label': 'gone', 'card_text': 'x'}],
                'card': {'seconds': 1, 'size': 30, 'wrap_chars': 30,
                         'line_step': 1.25, 'colour': 'black', 'text_colour': 'white', 'border_px': 2, 'noise_amplitude': 0.004},
                'work': str(Path(self.tmp.name) / 'reel' / 'cards'), 'out': str(Path(self.tmp.name) / 'reel' / 'reel.mp4'),
                'index': str(Path(self.tmp.name) / 'reel' / 'index.txt'), 'folders': req['folders']}
        code, out = run_tool('string-together', reel)
        self.assertEqual(code, 0, out)
        self.assertEqual([f['label'] for f in out['result']['films']], ['first', 'second'])
        self.assertEqual(out['result']['missing'], ['/no/such/file.mp4'])
        self.assertGreater(out['result']['films'][1]['start'], out['result']['films'][0]['seconds'] + 0.9)


if __name__ == '__main__':
    unittest.main()
