#!/usr/bin/env python3 -I
"""Tests of the claim check on a made-up world (test/fixture_world.py). Run: python3 -I test/test_claim_check.py

The first seven are the old fact gate's own regression tests, one for one: a claim a person makes on their own footage is
stated plainly and the record says whose it is; hedge and attribution wording never passes; a claim too weak to state
plainly fails and is cut, never hedged. The rest cover the other rules, the world's own check and the two commands."""
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
FOLDER = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(FOLDER, 'read-data'))
sys.path.insert(0, HERE)
import claim_gate  # noqa: E402
import fixture_world  # noqa: E402
import world_rows  # noqa: E402

CHECK = os.path.join(FOLDER, 'do-work', 'check_claims.py')
EXTRACTS = os.path.join(FOLDER, 'do-work', 'make_source_extracts.py')


def claim(words, **kw):
    return {'words': words, 'kind': 'claim', **kw}


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.request = fixture_world.build(self.dir)
        r = self.request
        self.config = claim_gate.Config(r['lane_dir'], r['sources'], r['frames_root'], r['world_dir'], r['hedge_phrases'], fixture_world.SETTINGS)
        self.gate = claim_gate.Gate(self.config)

    def shot(self, sid):
        return self.gate.check_shot(sid)[0]

    def entry(self, entry, words=None):
        fails, notes = [], []
        self.gate.check_entry(entry, words or entry['words'], 'test', fails, notes)
        return fails, notes

    def add_shot(self, sid, script, voice, events=(), screen=()):
        lane = self.request['lane_dir']
        fixture_world.write(os.path.join(lane, 'shots', f'{sid}.json'), {'id': sid, 'voice': {'script': f'scripts/{sid}.txt'}, 'events': list(events)})
        fixture_world.write(os.path.join(lane, 'scripts', f'{sid}.txt'), script + '\n')
        fixture_world.write(os.path.join(lane, 'claims', f'{sid}.json'), {'voice': voice, 'screen': list(screen)})


class OldRegressionTests(Base):
    def test_her_own_claim_stated_plainly_passes(self):
        self.assertEqual(self.shot('own-claim-plain'), [])

    def test_attribution_and_estimate_wording_is_flagged(self):
        fails = self.shot('attributed-hedge')
        self.assertTrue(any('"she reports"' in f or '"reports:"' in f for f in fails), fails)
        self.assertTrue(any('"estimate"' in f or '"her estimate"' in f for f in fails), fails)

    def test_claim_with_no_support_fails(self):
        self.assertTrue(any('cites no world fact and no source' in f for f in self.shot('unsupported')))

    def test_claim_not_recorded_as_her_statement_fails(self):
        fid = 'f-mission-claim'
        original = self.gate.world.facts[fid]
        unrecorded = copy.deepcopy(original)
        del unrecorded['source_at_s']
        self.gate.world.facts[fid] = unrecorded
        try:
            fails = self.shot('own-claim-plain')
        finally:
            self.gate.world.facts[fid] = original
        self.assertTrue(any('not recorded as his statement' in f for f in fails), fails)

    def test_belief_too_weak_to_state_plainly_fails(self):
        fails, _ = self.entry(claim('Lentils are the best food there is.', facts=['f-lentils-belief'],
                                    considered={'f-pip-note': 'the narrator, not support'}))
        self.assertTrue(any('too weak to state plainly' in f for f in fails), fails)

    def test_every_hedge_phrase_is_flagged(self):
        for phrase in fixture_world.HEDGES:
            self.assertIn(phrase, claim_gate.hedges_in(f'Before {phrase} after', fixture_world.HEDGES), phrase)

    def test_container_regression_still_fails(self):
        self.assertTrue(any('per tablet' in f for f in self.shot('iron-tablet')), self.shot('iron-tablet'))
        self.assertEqual(self.shot('iron-serving'), [])


class OtherRules(Base):
    def test_the_subject_and_narrator_names_come_from_settings(self):
        fails, _ = self.entry(claim('She cooks with Sam.', topics=['sam'], facts=['f-pip-note'],
                                    considered={'f-friend': 'the same Sundays'}))
        self.assertIn('is about Mara but cites no world fact or transcript said by someone other than Pip', ' '.join(fails))

    def test_a_fact_on_the_topic_must_be_cited_or_considered(self):
        fails, _ = self.entry(claim('She takes eighteen milligrams of iron.', topics=['iron'], facts=['f-iron-dose'],
                                    numbers=[{'spoken': 'eighteen', 'value': 18, 'fact': 'f-iron-dose'}]))
        self.assertTrue(any('f-iron-past is on topic' in f for f in fails), fails)

    def test_a_named_item_becomes_a_topic(self):
        fails, _ = self.entry(claim('Sam likes lentils.', facts=['f-friend']))
        self.assertTrue(any('f-lentils-belief is on topic' in f for f in fails), fails)

    def test_a_number_outside_its_qualifier_fails_and_inside_passes(self):
        base = dict(topics=['iron'], facts=['f-iron-dose'], considered={'f-iron-past': 'earlier'})
        fails, _ = self.entry(claim('She takes about twenty five milligrams of iron.', **base,
                                    numbers=[{'spoken': 'twenty five', 'value': 18, 'fact': 'f-iron-dose'}]))
        self.assertTrue(any('but the sources give 18' in f for f in fails), fails)
        fails, notes = self.entry(claim('She takes about nineteen milligrams of iron.', **base,
                                        numbers=[{'spoken': 'nineteen', 'value': 18, 'fact': 'f-iron-dose'}]))
        self.assertEqual(fails, [])
        self.assertTrue(any('"about nineteen" = 19' in n for n in notes), notes)

    def test_a_number_with_no_entry_or_not_in_its_source_fails(self):
        base = dict(topics=['iron'], facts=['f-iron-dose'], considered={'f-iron-past': 'earlier'})
        fails, _ = self.entry(claim('She takes eighteen milligrams of iron.', **base))
        self.assertTrue(any('with no numbers entry' in f for f in fails), fails)
        fails, _ = self.entry(claim('She takes twelve milligrams of iron.', **base,
                                    numbers=[{'spoken': 'twelve', 'value': 12, 'fact': 'f-iron-dose'}]))
        self.assertTrue(any('number 12 is not in fact f-iron-dose' in f for f in fails), fails)

    def test_a_strong_word_must_be_bound_to_a_support_that_says_it_as_strongly(self):
        base = dict(sources=[{'source': 'iron-sheet', 'quote': 'Lentils, 1 cup cooked 6.6 mg.'}],
                    considered={'f-lentils-belief': 'not relied on', 'f-pip-note': 'the narrator'},
                    numbers=[{'spoken': 'one', 'role': 'wording', 'why': 'a cup'}])
        fails, _ = self.entry(claim('Lentils always give iron, one cup at a time.', **base))
        self.assertTrue(any('says "always"' in f and 'without naming' in f for f in fails), fails)
        fails, _ = self.entry(claim('Lentils always give iron, one cup at a time.', strength={'always': 'source iron-sheet'}, **base))
        self.assertTrue(any('is stronger than its source on scope' in f for f in fails), fails)

    def test_a_comparison_without_numbers_must_hold(self):
        cmp_ok = {'says': 'less iron than her tablet', 'left': 'cup', 'op': '<', 'right': 'dose',
                  'inputs': {'cup': {'value': 6.6, 'source': 'iron-sheet'}, 'dose': {'value': 18, 'fact': 'f-iron-dose'}}}
        base = dict(topics=['iron'], facts=['f-iron-dose'], considered={'f-iron-past': 'earlier', 'f-lentils-belief': 'not relied on',
                                                                       'f-pip-note': 'the narrator'},
                    sources=[{'source': 'iron-sheet', 'quote': 'Lentils, 1 cup cooked 6.6 mg.'}],
                    numbers=[{'spoken': 'one', 'role': 'wording', 'why': 'a cup'}])
        fails, notes = self.entry(claim('One cup of lentils has less iron than her tablet.', compare=[cmp_ok], **base))
        self.assertEqual(fails, [])
        fails, _ = self.entry(claim('One cup of lentils has less iron than her tablet.', compare=[dict(cmp_ok, op='>')], **base))
        self.assertTrue(any('comparison does not hold' in f for f in fails), fails)

    def test_a_bound_broken_by_a_world_fact_fails(self):
        fails, _ = self.entry(claim('She takes at most ten milligrams of iron.', topics=['iron'], facts=['f-iron-past'],
                                    considered={'f-iron-dose': 'weighed'},
                                    numbers=[{'spoken': 'ten', 'value': 10, 'fact': 'f-iron-past'}]))
        self.assertTrue(any('is contradicted by world fact f-iron-dose' in f for f in fails), fails)

    def test_a_past_fact_needs_a_past_word(self):
        base = dict(topics=['iron'], considered={'f-iron-dose': 'what she takes now'},
                    numbers=[{'spoken': 'ten', 'value': 10, 'fact': 'f-iron-past'}], facts=['f-iron-past'])
        fails, _ = self.entry(claim('She takes ten milligrams of iron.', **base))
        self.assertTrue(any('does not say it as past' in f for f in fails), fails)
        fails, _ = self.entry(claim('She used to take ten milligrams of iron.', **base))
        self.assertFalse(any('does not say it as past' in f for f in fails), fails)

    def test_a_private_or_conflicting_fact_fails(self):
        world = self.gate.world
        world.facts['f-friend'] = dict(world.facts['f-friend'], private='yes', conflicts_with=['f-mission-hook'])
        fails, _ = self.entry(claim('Sam cooks with her on Sundays.', topics=['sam'], facts=['f-friend']))
        self.assertTrue(any('which is private' in f for f in fails), fails)
        self.assertTrue(any('conflicts with f-mission-hook' in f for f in fails), fails)

    def test_a_seen_thing_needs_a_saved_frame_with_what_is_seen_and_where(self):
        frame = {'frame': 'frames/pot.png', 'observed': 'a pot on the stove', 'shown': ''}
        fails, _ = self.entry(claim('There is a pot on the stove.', sources=[frame]))
        self.assertTrue(any('frames/pot.png does not exist' in f for f in fails), fails)
        fixture_world.write(os.path.join(self.request['frames_root'], 'frames', 'pot.png'), 'png')
        fails, _ = self.entry(claim('There is a pot on the stove.', sources=[frame]))
        self.assertTrue(any('needs `observed`' in f for f in fails), fails)
        fails, _ = self.entry(claim('There is a pot on the stove.', sources=[dict(frame, shown='the opening still')]))
        self.assertEqual(fails, [])

    def test_a_transcript_quote_must_be_at_its_second(self):
        quote = {'transcript': 'take-1.words.json', 'at_s': 6.0, 'quote': 'Lentils are cheap.'}
        base = dict(considered={'f-lentils-belief': 'not relied on', 'f-pip-note': 'the narrator'})
        self.assertEqual(self.entry(claim('Lentils are cheap.', sources=[quote], **base))[0], [])
        fails, _ = self.entry(claim('Lentils are cheap.', sources=[dict(quote, at_s=2.0)], **base))
        self.assertTrue(any('words at 2.0 s are' in f for f in fails), fails)

    def test_a_source_wording_must_be_in_the_source(self):
        fails, _ = self.entry(claim('Spinach has iron.', sources=[{'source': 'iron-sheet', 'quote': 'Spinach, 1 cup cooked 9 mg.'}]))
        self.assertTrue(any('does not contain "Spinach, 1 cup cooked 9 mg."' in f for f in fails), fails)
        fails, _ = self.entry(claim('Spinach has iron.', sources=[{'source': 'nowhere', 'quote': 'x'}]))
        self.assertTrue(any('source nowhere is not in' in f for f in fails), fails)

    def test_questions_labels_and_quotes(self):
        self.assertEqual(self.entry({'words': 'Would you eat lentil soup?', 'kind': 'no-claim'})[0], [])
        self.assertEqual(self.entry({'words': 'Tell her in the comments.', 'kind': 'no-claim'})[0], [])
        self.assertTrue(self.entry({'words': 'Lentils are cheap.', 'kind': 'no-claim'})[0])
        self.assertEqual(self.entry({'words': 'narrated by Pip', 'kind': 'label'})[0], [])
        self.assertTrue(self.entry({'words': 'narrated by someone', 'kind': 'label'})[0])
        quote = {'transcript': 'take-1.words.json', 'at_s': 6.0, 'quote': 'Lentils are cheap.'}
        self.assertEqual(self.entry({'words': 'Lentils, um, are cheap.', 'kind': 'quote', 'sources': [quote]})[0], [])
        self.assertTrue(self.entry({'words': 'Lentils are free.', 'kind': 'quote', 'sources': [quote]})[0])

    def test_coverage_of_the_script_and_of_every_screen_text(self):
        self.add_shot('cover', 'My mission is the cheapest balanced meals in town. Watch this.',
                      [fixture_world.SHOTS['own-claim-plain'][1][0]],
                      events=[{'type': 'note', 'text': 'narrated by Pip'},
                              {'type': 'figure', 'id': 'f1', 'label': 'iron', 'fmt': '{:.0f}', 'value_to': 18, 'suffix': ' mg'}],
                      screen=[{'text': 'narrated by Pip', 'kind': 'label'}, {'text': 'not on screen', 'kind': 'label'}])
        fails = self.shot('cover')
        self.assertTrue(any('voice claims do not cover the script exactly' in f for f in fails), fails)
        self.assertTrue(any('screen figure f1: "iron / 18 mg" has no claims entry' in f for f in fails), fails)
        self.assertTrue(any('"not on screen" is not on screen' in f for f in fails), fails)


class WorldAndCommands(Base):
    def test_the_made_up_world_passes_its_own_check(self):
        ok, lines = world_rows.verify(self.gate.world)
        self.assertTrue(ok, lines)
        self.assertEqual(lines[-1], 'verify: ok')

    def test_a_broken_world_stops_every_shot(self):
        self.gate.world.facts['f-mission-claim']['source_at_s'] = 9.0
        ok, lines, fails, _ = claim_gate.check(self.config, 'own-claim-plain', world=self.gate.world)
        self.assertFalse(ok)
        self.assertEqual(lines[0], 'world graph verify failed:')
        self.assertIn('PROBLEM fact f-mission-claim: no word starts at 9.0 s', lines)

    def test_path_map_reads_paths_written_on_another_computer(self):
        self.gate.world.facts['f-friend']['source'] = '/elsewhere/world/notes.txt'
        config = claim_gate.Config(*[self.request[k] for k in ('lane_dir', 'sources', 'frames_root', 'world_dir', 'hedge_phrases')], fixture_world.SETTINGS,
                                   path_map={'/elsewhere/world': self.request['world_dir']})
        self.assertTrue(world_rows.verify(self.gate.world, config.path_map)[0])
        self.assertFalse(world_rows.verify(self.gate.world)[0])

    def run_check(self, request):
        done = subprocess.run([sys.executable, '-I', CHECK], input=json.dumps(request), capture_output=True, text=True)
        return done.returncode, json.loads(done.stdout.strip().splitlines()[-1])

    def test_the_command_answers_every_shot(self):
        code, answer = self.run_check(self.request)
        self.assertEqual(code, 1)
        result = answer['result']
        self.assertTrue(result['world']['ok'])
        verdict = {s['id']: s['ok'] for s in result['shots']}
        self.assertEqual(verdict, {'attributed-hedge': False, 'iron-serving': True, 'iron-tablet': False, 'own-claim-plain': True,
                                   'unsupported': False})
        self.assertEqual(result['shots'][0]['lines'][-1], 'fact gate attributed-hedge: 3 failures')
        code, answer = self.run_check(dict(self.request, shots=['own-claim-plain', 'iron-serving']))
        self.assertEqual((code, answer['result']['ok']), (0, True))

    def test_a_missing_script_is_a_failure_not_a_crash(self):
        os.remove(os.path.join(self.request['lane_dir'], 'scripts', 'unsupported.txt'))
        code, answer = self.run_check(dict(self.request, shots=['unsupported']))
        self.assertEqual(code, 1)
        self.assertIn('missing file', answer['result']['shots'][0]['fails'][0])

    def test_refusals_say_what_to_change(self):
        for request, words in [({}, 'the request lacks'), (dict(self.request, shots=[]), 'shots must be'),
                               (dict(self.request, settings_record=fixture_world.setting_row({'rules': {}})), 'settings.rules lacks'),
                               (dict(self.request, settings_record=fixture_world.setting_row(tool='tool:another')), 'not tool:check-every-claim'),
                               (dict(self.request, settings_record=fixture_world.setting_row(status='retired')), "'retired'"),
                               ({k: v for k, v in self.request.items() if k != 'settings_record'}, 'has no settings_record'),
                               (dict(self.request, world_dir=self.dir), 'world_dir has no lists.json'),
                               (dict(self.request, settings_record='record:setting:x~film~y'), 'run-with-settings.mjs')]:
            code, answer = self.run_check(request)
            self.assertEqual(code, 2, answer)
            self.assertIn(words, answer['error'])

    def test_the_requests_own_settings_lay_over_the_row(self):
        code, answer = self.run_check(dict(self.request, shots=['unsupported'], settings={'subject_name': 'Someone'}))
        self.assertEqual(code, 1)
        code, answer = self.run_check(dict(self.request, shots=['attributed-hedge'], settings={'hedge_row': 'row H'}))
        self.assertIn('(row H)', answer['result']['shots'][0]['fails'][0])

    def test_the_settings_wrapper_hands_the_settings_through(self):
        wrapper = os.path.join(os.path.dirname(FOLDER), 'settings', 'do-work', 'run-with-settings.mjs')
        if not os.path.exists(wrapper) or not shutil.which('node'):
            self.skipTest('tools/settings or node is not here')
        done = subprocess.run(['node', wrapper, '--folder', 'check-every-claim-against-its-facts-and-sources', '--', sys.executable, '-I', CHECK],
                              input=json.dumps(dict(self.request, shots=['own-claim-plain'])), capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertTrue(json.loads(done.stdout.strip().splitlines()[-1])['result']['ok'])

    def test_source_extracts_are_made_from_the_raw_files(self):
        os.remove(os.path.join(os.path.dirname(self.request['sources']), 'iron.txt'))
        done = subprocess.run([sys.executable, '-I', EXTRACTS], input=json.dumps({'sources': self.request['sources']}),
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(json.loads(done.stdout.strip().splitlines()[-1])['result']['sources'][0]['id'], 'iron-sheet')
        with open(os.path.join(os.path.dirname(self.request['sources']), 'iron.txt')) as f:
            self.assertEqual(f.read(), fixture_world.SOURCE_TEXT + '\n')
        self.assertEqual(self.shot('iron-serving'), [])

    def test_every_extract_kind(self):
        sys.path.insert(0, os.path.join(FOLDER, 'do-work'))
        import make_source_extracts as mx
        food = {'description': 'Lentils, cooked', 'fdcId': 1, 'foodNutrients': [{'nutrient': {'name': 'Iron', 'unitName': 'mg'}, 'amount': 3.3},
                                                                              {'nutrient': {'name': 'Zinc', 'unitName': 'mg'}}]}
        self.assertEqual(mx.from_fdc_json(json.dumps(food)), 'Lentils, cooked (FDC ID 1), amounts per 100 g\nIron: 3.3 mg\n')
        plan = {'new_order': [{'id': 'N01', 'clip': 'A1', 'src_in': 1.5, 'src_out': 4, 'dur': 2.5, 'inner_cut_s': 0, 'note': 'open'}]}
        self.assertEqual(mx.from_new_order(json.dumps(plan)), 'N01: A1 1.5-4, dur 2.5 s, inner cuts 0 s (open)\n')
        self.assertEqual(mx.from_html('<script>x</script><p>a &amp; b</p>'), 'a & b\n')
        sources = os.path.join(self.dir, 'gate2', 'sources.json')
        fixture_world.write(sources, {'sources': {'t': {'raw': 'x.json', 'extract': 'whisper-words', 'text': 'missing.txt'}}})
        done = subprocess.run([sys.executable, '-I', EXTRACTS], input=json.dumps({'sources': sources}), capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)
        self.assertIn('has no builder here', json.loads(done.stdout.strip().splitlines()[-1])['error'])


if __name__ == '__main__':
    unittest.main()
