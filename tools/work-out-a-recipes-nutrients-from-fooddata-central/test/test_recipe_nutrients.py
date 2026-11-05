"""Tests of work-out-a-recipes-nutrients-from-fooddata-central on made-up FoodData-Central-shaped CSVs: two tiny
datasets (a and b), made-up foods and made-up amounts. Nothing here is a real person's recipe or real USDA data."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

FOLDER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(FOLDER, 'read-data'))

from fooddata_central import Refusal, load_texts, per100, portion_g  # noqa: E402
from recipe_profile import fill, work_out  # noqa: E402

DO_WORK = os.path.join(FOLDER, 'do-work', 'work_out_recipe_nutrients.py')

NUTRIENT = 'id,name,unit_name\n1003,Protein,G\n1008,Energy,KCAL\n2047,Energy (Atwater General),KCAL\n1093,Sodium,MG\n'
# Food 11 (dataset a): protein 10, energy only under 2047 (the fallback), sugars only under 1063, an empty calcium
# amount, and a later protein row that wins. Food 12: sodium only, lots of it. Food 21 (dataset b): energy 1008.
A = {
    'nutrient': NUTRIENT,
    'food_nutrient': ('id,fdc_id,nutrient_id,amount\n'
                      '1,11,1003,8\n2,11,2047,100\n3,11,1063,4\n4,11,1087,\n5,11,1003,10\n6,11,1004,5\n8,11,1093,10\n'
                      '7,12,1093,38000\n'),
    'food_portion': ('id,fdc_id,seq_num,amount,measure_unit_id,portion_description,modifier,gram_weight\n'
                     '1,11,1,0.5,9,,Cup,120\n2,11,2,1,9,,cup,999\n3,12,1,1,9,1 tsp,,6\n'),
    'food': 'fdc_id,description\n11,Made-up bean curd\n12,Made-up salt\n',
}
B = {
    'food_nutrient': 'id,fdc_id,nutrient_id,amount\n1,21,1008,40\n2,21,1003,3\n3,21,1087,120\n4,21,1079,50\n',
    'food_portion': 'id,fdc_id,seq_num,amount,measure_unit_id,portion_description,modifier,gram_weight\n',
}


def request(**over):
    r = {
        'id': 'made-up-pudding', 'title': 'Made-up pudding', 'built': '2026-01-01T00:00:00+00:00',
        'datasets': {'a': A, 'b': B},
        'ingredients': [
            {'id': 'curd', 'name': 'Bean curd', 'amount': '200 g', 'fdc_id': '11', 'dataset': 'a', 'grams': 200, 'base': True},
            {'id': 'drink', 'name': 'Drink', 'amount': '1 cup', 'fdc_id': '21', 'dataset': 'b',
             'portion': {'dataset': 'a', 'fdc_id': '11', 'unit_contains': 'cup', 'count': 1}},
            {'id': 'salt', 'name': 'Salt', 'amount': 'half a tsp', 'fdc_id': 12, 'dataset': 'a',
             'portion': {'unit_contains': 'tsp', 'count': 0.5}},
            {'id': 'sweetener', 'name': 'Sweetener', 'amount': 'some'},
        ],
    }
    r.update(over)
    return r


def run(req):
    tables = {name: load_texts(texts, name) for name, texts in req['datasets'].items()}
    return work_out(req, tables, req['built'])


def row(answer, key):
    return next(r for r in answer['profile']['nutrients'] if r['key'] == key)


class ReadingFoodDataCentral(unittest.TestCase):
    def test_fallback_ids_empty_amounts_and_the_last_row_wins(self):
        t = load_texts(A, 'a')
        p = per100(t, '11')
        self.assertEqual(p['energy'], 100.0)      # 1008 absent, 2047 read
        self.assertEqual(p['sugars'], 4.0)        # 2000 absent, 1063 read
        self.assertIsNone(p['calcium'])           # empty amount skipped
        self.assertEqual(p['protein'], 10.0)      # the later row for the same nutrient wins
        self.assertEqual(t[3]['11'], 'Made-up bean curd')
        self.assertEqual(t[0]['1003']['name'], 'Protein')

    def test_portion_is_the_first_match_per_one_unit_case_insensitive(self):
        t = load_texts(A, 'a')
        grams, r = portion_g(t, '11', 'CUP')
        self.assertEqual(grams, 240.0)            # 120 g / 0.5, the first matching row
        self.assertEqual(r['id'], '1')
        self.assertEqual(portion_g(t, '12', 'tsp')[0], 6.0)   # matched in portion_description
        with self.assertRaises(Refusal):
            portion_g(t, '11', 'tbsp')

    def test_a_food_with_no_amounts_and_a_missing_file_are_refused(self):
        with self.assertRaises(Refusal):
            per100(load_texts(A, 'a'), '99')
        with self.assertRaises(Refusal):
            load_texts({'food_nutrient': A['food_nutrient']}, 'a')
        self.assertEqual(load_texts(B, 'b')[3], {})   # food.csv and nutrient.csv are optional as texts

    def test_placeholders(self):
        self.assertEqual(fill('scaled by {scale:.3f} {other}', scale=0.83794), 'scaled by 0.838 {other}')
        self.assertEqual(fill('about {mix_g:.0f} g', mix_g=696.84), 'about 697 g')
        self.assertEqual(fill('no scale {scale}', scale=None), 'no scale {scale}')


class WorkingOutTheProfile(unittest.TestCase):
    def test_grams_portions_mass_and_rounding(self):
        a = run(request())
        p = a['profile']
        self.assertEqual(p['mix_mass_g'], 443.0)  # 200 + 1 x 240 + 0.5 x 6
        energy = row(a, 'energy')
        self.assertEqual(energy['per_batch'], 296.0)          # 100 x 2 + 40 x 2.4
        self.assertEqual(energy['per_100g'], round(296 / 443 * 100, 3))
        self.assertEqual(p['per_ingredient_contribution_per_batch']['drink'], {'energy': 96.0, 'protein': 7.2, 'fibre': 120.0, 'calcium': 288.0})
        self.assertEqual(p['food_data_sources'], {'curd': {'fdc_id': '11', 'dataset': 'a'}, 'drink': {'fdc_id': '21', 'dataset': 'b'},
                                                  'salt': {'fdc_id': '12', 'dataset': 'a'}})
        self.assertEqual(p['cross_check'], {'this_model': {'kcal': 296.0, 'protein_g': 27.2}})
        self.assertEqual(p['scale_factors'], {})
        self.assertEqual(row(a, 'protein')['pct_dri_male'], round(27.2 / 56 * 100, 1))
        self.assertNotIn('sweetener', p['per_ingredient_contribution_per_batch'])

    def test_scale_to_a_label(self):
        req = request()
        req['ingredients'][0]['scale_to_label'] = {'nutrient': 'protein', 'amount': 25}
        req['ingredients'][0]['modelling_note'] = 'scaled by {scale:.3f} to the label'
        a = run(req)
        k = 25 / (10 * 200 / 100)
        self.assertEqual(a['profile']['scale_factors'], {'curd': round(k, 4)})
        self.assertEqual(row(a, 'energy')['per_batch'], round(100 * 2 * k + 96, 3))
        self.assertEqual(a['recipe']['ingredients'][0]['modelling_note'], 'scaled by 1.250 to the label')

    def test_flags_limits_unknowns_in_a_base_and_caveats(self):
        a = run(request(nutrient_caveats={'carbs': 'made-up caveat'}))
        self.assertEqual(row(a, 'sodium')['flag'], 'not_a_gap_sodium_is_a_limit')
        calcium = row(a, 'calcium')            # the base ingredient (curd) has no calcium
        self.assertEqual(calcium['ingredients_without_data'], ['curd', 'salt'])
        self.assertEqual(calcium['flag'], 'unknown_lower_bound_only')
        self.assertEqual(calcium['caveat'], 'USDA has no value for curd, salt; the figure counts the other ingredients only')
        self.assertEqual(row(a, 'carbs')['caveat'], 'made-up caveat')
        self.assertNotIn('dri_kind', row(a, 'energy'))
        req = request()
        req['ingredients'][0]['base'] = False
        self.assertEqual(row(run(req), 'calcium')['flag'], 'low')     # 288 mg of 1000: 28.8 %
        # The thresholds on the lower of the two percentages: nothing (gap), 28.8 % (low), 48.6 % (a third), fibre
        # 120 g against 38 g and 25 g (a full day).
        other = run(req)
        self.assertEqual([row(other, k)['flag'] for k in ('iron', 'calcium', 'protein', 'fibre')],
                         ['gap', 'low', 'meets_a_third_or_more', 'meets_full_day'])

    def test_the_recipe_carries_the_persons_words(self):
        req = request(yield_note='one bowl: about {mix_g:.0f} g', recipe_notes={'method': {'steps': ['Blend.']}, 'id': 'ignored'},
                      cross_check={'their_count': {'kcal': 300}})
        req['ingredients'][3].update(amount_status='a guess', evidence=[{'said': 'made-up words'}])
        a = run(req)
        r = a['recipe']
        self.assertEqual(list(r), ['id', 'title', 'built', 'yield_note', 'ingredients', 'method'])
        self.assertEqual(r['yield_note'], 'one bowl: about 443 g')
        self.assertEqual(r['ingredients'][3], {'id': 'sweetener', 'name': 'Sweetener', 'amount': 'some', 'grams_used_in_profile': None,
                                               'amount_status': 'a guess', 'evidence': [{'said': 'made-up words'}]})
        self.assertEqual(r['ingredients'][1]['grams_used_in_profile'], 240.0)
        self.assertEqual(list(a['profile']['cross_check']), ['their_count', 'this_model'])

    def test_summary_lines_print_the_table(self):
        lines = run(request())['summary_lines']
        self.assertEqual(len(lines), 34)
        self.assertEqual(lines[0], 'Energy' + ' ' * 24 + '    296.00 kcal  %DRI m/f: (None, None, None) [\'salt\']')
        self.assertEqual(lines[1], 'Protein' + ' ' * 23 + '     27.20 g    %DRI m/f: (48.6, 59.1, \'meets_a_third_or_more\') [\'salt\']')
        self.assertTrue(lines[-1].startswith('mass 443.0 drink g 240.0 salt g 3.0'))

    def test_refusals(self):
        for bad, words in [(request(ingredients=[]), 'no ingredients'),
                           (request(ingredients=[{'id': 'x', 'fdc_id': '11', 'dataset': 'c', 'grams': 1}]), 'dataset "c"'),
                           (request(ingredients=[{'id': 'x', 'fdc_id': '11', 'grams': 1}]), 'no dataset'),
                           (request(ingredients=[{'id': 'x', 'fdc_id': '11', 'dataset': 'a'}]), 'no grams'),
                           (request(ingredients=[{'id': 'x'}, {'id': 'x'}]), 'share the id'),
                           (request(ingredients=[{'id': 'x'}]), 'no ingredient with an fdc_id')]:
            with self.assertRaises(Refusal) as e:
                run(bad)
            self.assertIn(words, str(e.exception))


class TheCommand(unittest.TestCase):
    def call(self, args=(), stdin=''):
        r = subprocess.run([sys.executable, '-I', DO_WORK, *args], input=stdin, capture_output=True, text=True)
        return r.returncode, json.loads(r.stdout.strip().splitlines()[-1])

    def test_stdin_dataset_folders_and_write_to(self):
        with tempfile.TemporaryDirectory() as d:
            for name, texts in (('a', A), ('b', B)):
                os.makedirs(os.path.join(d, name))
                for file, text in texts.items():
                    with open(os.path.join(d, name, file + '.csv'), 'w', encoding='utf-8') as f:
                        f.write(text)
            out = os.path.join(d, 'out')
            os.makedirs(out)
            req = request(datasets={'a': {'dir': os.path.join(d, 'a')}, 'b': {'dir': os.path.join(d, 'b')}}, write_to=out)
            code, answer = self.call(stdin=json.dumps(req))
            self.assertEqual(code, 0, answer)
            self.assertEqual(answer['profile']['mix_mass_g'], 443.0)
            with open(os.path.join(out, 'made-up-pudding.profile.json'), encoding='utf-8') as f:
                self.assertEqual(json.load(f), answer['profile'])
            self.assertEqual(len(answer['written']), 2)
            path = os.path.join(d, 'request.json')
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(request(), f)
            code, again = self.call(['--request', path])
            self.assertEqual((code, again['profile']), (0, answer['profile']))

    def test_the_saved_recipe_is_read_from_list_settings(self):
        saved = {k: v for k, v in request().items() if k != 'datasets'}
        folder = 'work-out-a-recipes-nutrients-from-fooddata-central'
        def row(piece, value):
            return {'id': f'record:setting:{folder}~piece~{piece}', 'type': 'record:setting',
                    'value': {'name': 'a made-up recipe', 'tool': 'tool:' + folder, 'scope_kind': 'piece', 'scope_id': piece,
                              'settings': json.dumps(value, sort_keys=True), 'from': 'made-up', 'status': 'active'}}
        other = dict(saved, id='another-recipe')
        req = {'settings_record': [row('other', other), row('pudding', saved)], 'piece': 'pudding',
               'datasets': {'a': A, 'b': B}, 'title': 'Given here wins'}
        code, answer = self.call(stdin=json.dumps(req))
        self.assertEqual(code, 0, answer)
        self.assertEqual(answer['profile']['id'], 'made-up-pudding')
        self.assertEqual(answer['profile']['mix_mass_g'], 443.0)
        self.assertEqual(answer['recipe']['title'], 'Given here wins')
        code, answer = self.call(stdin=json.dumps(dict(req, piece='missing')))
        self.assertEqual(code, 1)
        self.assertIn('no list:settings row for piece missing', answer['error'])
        retired = row('pudding', saved)
        retired['value']['status'] = 'retired'
        code, answer = self.call(stdin=json.dumps(dict(req, settings_record=retired)))
        self.assertEqual(code, 1)
        self.assertIn('retired', answer['error'])

    def test_errors_say_what_to_change(self):
        self.assertEqual(self.call(stdin='not json'), (1, {'error': 'the request is not JSON: send one JSON object on standard input or with --request <file>'}))
        code, answer = self.call(stdin=json.dumps(request(datasets={'a': {'dir': '/no/such/folder'}})))
        self.assertEqual(code, 1)
        self.assertIn('has no food_nutrient.csv', answer['error'])
        code, answer = self.call(stdin=json.dumps({'datasets': {}}))
        self.assertIn('needs an id', answer['error'])


if __name__ == '__main__':
    unittest.main()
