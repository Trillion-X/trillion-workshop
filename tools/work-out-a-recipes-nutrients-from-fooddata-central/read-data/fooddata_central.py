"""Builds the tofu ice cream v1 recipe + nutrient profile rows from USDA FoodData Central CSV downloads.

usage: tofu_ice_cream_profile.py <sr_legacy_dir> <foundation_dir> <out_dir>
"""
import csv, json, sys, datetime

SR, FOUND, OUT = sys.argv[1], sys.argv[2], sys.argv[3]

def load(base):
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

srd, fod = load(SR), load(FOUND)

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

def per100(src, fdc):
    nut, fn, port, food = src
    row = fn[fdc]
    out = {}
    for key, _, _, ids in NUTS:
        out[key] = next((row[i] for i in ids if i in row), None)
    return out

def portion_g(src, fdc, modifier_contains):
    for r in src[2][fdc]:
        if modifier_contains in (r['modifier'] + ' ' + r['portion_description']).lower():
            return float(r['gram_weight']) / float(r['amount']), r
    raise SystemExit('no portion %s %s' % (fdc, modifier_contains))

TOFU_SR = '172475'   # Tofu, raw, firm, prepared with calcium sulfate
SOY_F = '1750337'    # Soy milk, unsweetened, plain, shelf stable (Foundation)
SOY_SR = '175215'    # Soymilk unsweetened (for the cup weight)
COCOA = '169593'
VANILLA = '173471'
SALT = '173468'

soy_cup_g, _ = portion_g(srd, SOY_SR, 'cup')
cocoa_tbsp_g, _ = portion_g(srd, COCOA, 'tbsp')
vanilla_tbsp_g, _ = portion_g(srd, VANILLA, 'tbsp')
salt_tsp_g, _ = portion_g(srd, SALT, 'tsp')
