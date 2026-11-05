"""Reads USDA FoodData Central CSV downloads (SR Legacy, Foundation, or any dataset in the same layout) and answers
per-100 g nutrient amounts and portion weights, with the reference data a profile is measured against: the nutrients
(NUTS), the adult 19-30 Dietary Reference Intakes (DRI) and the nutrients that are limits, not targets (DOSE_MAX).

A dataset is the four CSVs FoodData Central ships in each download folder:
  nutrient.csv       id, name, unit_name, ...           (read but not needed: the profile's units are its own)
  food_nutrient.csv  fdc_id, nutrient_id, amount, ...   (amount per 100 g of the food; an empty amount is skipped)
  food_portion.csv   fdc_id, amount, modifier, portion_description, gram_weight, ...
  food.csv           fdc_id, description, ...
`load(base)` reads them from a folder; `load_texts(texts)` from their texts (food.csv and nutrient.csv optional there).
Everything else here is pure.
"""
import csv, io, os

# nutrient key -> (label, unit, [FDC nutrient ids tried in order])
NUTS = [
 ('energy', 'Energy', 'kcal', ['1008', '2047']),
 ('protein', 'Protein', 'g', ['1003']),
 ('fat', 'Total fat', 'g', ['1004']),
 ('sat_fat', 'Saturated fat', 'g', ['1258']),
 ('carbs', 'Carbohydrate', 'g', ['1005']),
 ('fibre', 'Dietary fibre', 'g', ['1079']),
 ('sugars', 'Total sugars', 'g', ['2000', '1063']),
 ('linoleic', 'Linoleic acid (n-6)', 'g', ['1316', '1269']),
 ('ala', 'Alpha-linolenic acid (n-3)', 'g', ['1404', '1270']),
 ('calcium', 'Calcium', 'mg', ['1087']),
 ('iron', 'Iron', 'mg', ['1089']),
 ('magnesium', 'Magnesium', 'mg', ['1090']),
 ('phosphorus', 'Phosphorus', 'mg', ['1091']),
 ('potassium', 'Potassium', 'mg', ['1092']),
 ('sodium', 'Sodium', 'mg', ['1093']),
 ('zinc', 'Zinc', 'mg', ['1095']),
 ('copper', 'Copper', 'mg', ['1098']),
 ('manganese', 'Manganese', 'mg', ['1101']),
 ('selenium', 'Selenium', 'ug', ['1103']),
 ('iodine', 'Iodine', 'ug', ['1100']),
 ('vit_c', 'Vitamin C', 'mg', ['1162']),
 ('thiamin', 'Thiamin (B1)', 'mg', ['1165']),
 ('riboflavin', 'Riboflavin (B2)', 'mg', ['1166']),
 ('niacin', 'Niacin (B3)', 'mg', ['1167']),
 ('pantothenic', 'Pantothenic acid (B5)', 'mg', ['1170']),
 ('vit_b6', 'Vitamin B6', 'mg', ['1175']),
 ('folate', 'Folate', 'ug', ['1190', '1177']),
 ('vit_b12', 'Vitamin B12', 'ug', ['1178']),
 ('choline', 'Choline', 'mg', ['1180']),
 ('vit_a', 'Vitamin A (RAE)', 'ug', ['1106']),
 ('vit_d', 'Vitamin D', 'ug', ['1114']),
 ('vit_e', 'Vitamin E (alpha-tocopherol)', 'mg', ['1109']),
 ('vit_k', 'Vitamin K', 'ug', ['1185']),
]

# Adult 19-30 DRI, NASEM Dietary Reference Intakes summary tables (RDA unless kind=AI/CDRR). m, f.
# protein RDA uses NASEM reference weights (56 kg m / 46 kg f x 0.8 g/kg = 56 / 46 g); carbs RDA 130 g.
DRI = {
 'protein': (56, 46, 'RDA'), 'carbs': (130, 130, 'RDA'), 'fibre': (38, 25, 'AI'),
 'linoleic': (17, 12, 'AI'), 'ala': (1.6, 1.1, 'AI'),
 'calcium': (1000, 1000, 'RDA'), 'iron': (8, 18, 'RDA'), 'magnesium': (400, 310, 'RDA'),
 'phosphorus': (700, 700, 'RDA'), 'potassium': (3400, 2600, 'AI'), 'sodium': (1500, 1500, 'AI'),
 'zinc': (11, 8, 'RDA'), 'copper': (0.9, 0.9, 'RDA'), 'manganese': (2.3, 1.8, 'AI'),
 'selenium': (55, 55, 'RDA'), 'iodine': (150, 150, 'RDA'), 'vit_c': (90, 75, 'RDA'),
 'thiamin': (1.2, 1.1, 'RDA'), 'riboflavin': (1.3, 1.1, 'RDA'), 'niacin': (16, 14, 'RDA'),
 'pantothenic': (5, 5, 'AI'), 'vit_b6': (1.3, 1.3, 'RDA'), 'folate': (400, 400, 'RDA'),
 'vit_b12': (2.4, 2.4, 'RDA'), 'choline': (550, 425, 'AI'), 'vit_a': (900, 700, 'RDA'),
 'vit_d': (15, 15, 'RDA'), 'vit_e': (15, 15, 'RDA'), 'vit_k': (120, 90, 'AI'),
}

DOSE_MAX = {'sodium'}

# The header of each optional file, standing in for it when its text is not given.
OPTIONAL = {'nutrient': 'id,name,unit_name\n', 'food': 'fdc_id,description\n'}


class Refusal(Exception):
    """A request this cannot answer; the message says what to change."""


def load(base, open=open):
    nut = {r['id']: r for r in csv.DictReader(open(base + '/nutrient.csv'))}
    fn = {}
    for r in csv.DictReader(open(base + '/food_nutrient.csv')):
        if r['amount'] == '':
            continue
        fn.setdefault(r['fdc_id'], {})[r['nutrient_id']] = float(r['amount'])
    port = {}
    for r in csv.DictReader(open(base + '/food_portion.csv')):
        port.setdefault(r['fdc_id'], []).append(r)
    food = {r['fdc_id']: r['description'] for r in csv.DictReader(open(base + '/food.csv'))}
    return nut, fn, port, food


def load_dir(base, name='dataset'):
    """load(base) of a download folder, refused in words when the folder or a needed file is not there; a missing
    nutrient.csv or food.csv reads as its header alone."""
    for need in ('food_nutrient', 'food_portion'):
        if not os.path.exists(os.path.join(base, need + '.csv')):
            raise Refusal(f'dataset {name}: {base} has no {need}.csv: give the unzipped FoodData Central download folder')
    return load(base, open=open_text)


def open_text(path):
    name = os.path.basename(path)[:-4]
    if name in OPTIONAL and not os.path.exists(path):
        return io.StringIO(OPTIONAL[name], newline='')
    return io.open(path, encoding='utf-8', newline='')


def load_texts(texts, name='dataset'):
    """load() of the CSV texts of one dataset ({file name without .csv: text}); nutrient and food are optional."""
    for need in ('food_nutrient', 'food_portion'):
        if not isinstance(texts.get(need), str):
            raise Refusal(f'dataset {name} has no {need}.csv: give its text as "{need}" or its folder as "dir"')
    return load('', open=lambda path: io.StringIO(texts.get(path[1:-4], OPTIONAL.get(path[1:-4], '')), newline=''))


def per100(src, fdc):
    nut, fn, port, food = src
    if fdc not in fn:
        raise Refusal(f'food {fdc} has no nutrient amounts in its dataset: check the fdc_id and which dataset it is in')
    row = fn[fdc]
    out = {}
    for key, _, _, ids in NUTS:
        out[key] = next((row[i] for i in ids if i in row), None)
    return out


def portion_g(src, fdc, modifier_contains):
    modifier_contains = str(modifier_contains).lower()
    for r in src[2].get(fdc, []):
        if modifier_contains in (r['modifier'] + ' ' + r['portion_description']).lower():
            return float(r['gram_weight']) / float(r['amount']), r
    raise Refusal('no portion of food %s says "%s": give grams instead, or a word its food_portion rows use (cup, tbsp, tsp)' % (fdc, modifier_contains))
