"""Works out a recipe's nutrient profile from FoodData Central tables: every nutrient for the whole batch and per
100 g of mix, each ingredient's share, % of the adult 19-30 Dietary Reference Intake and a flag. Pure: it takes the
request and the loaded tables ({dataset name: fooddata_central.load(...)}) and answers {profile, recipe,
summary_lines}; nothing is read or written here.

The recipe is the person's: it comes in the request, never from this code.
"""
import re

from fooddata_central import DOSE_MAX, DRI, NUTS, Refusal, per100, portion_g

PLACEHOLDER = re.compile(r'\{(scale|mix_g)(?::([^}]*))?\}')
KEYS = {key for key, *_ in NUTS}


def fill(text, **values):
    """`text` with each {scale} / {mix_g} (optionally {scale:.3f}) replaced by its value; other braces kept."""
    if not isinstance(text, str):
        return text
    return PLACEHOLDER.sub(lambda m: format(values[m.group(1)], m.group(2) or '') if values.get(m.group(1)) is not None else m.group(0), text)


def dataset(tables, name, ingredient_id):
    if name not in tables:
        raise Refusal(f'ingredient {ingredient_id} names dataset "{name}", which the request does not give: '
                      f'add it under datasets (given: {", ".join(sorted(tables)) or "none"})')
    return tables[name]


def ingredients_of(request, tables):
    """The request's ingredients as the rows the profile sums: id, grams, fdc, db, scale (and the rest kept).
    grams is as given, or count x the grams of one portion; scale is as given (default 1), or the factor that makes
    one nutrient of the ingredient equal its pack label (scale_to_label)."""
    given = request.get('ingredients')
    if not isinstance(given, list) or not given:
        raise Refusal('the request has no ingredients: give a list, each with id, name and either fdc_id and dataset or none (counted as nothing)')
    seen = set()
    ingredients = []
    for one in given:
        if not isinstance(one, dict) or not isinstance(one.get('id'), str) or not one['id']:
            raise Refusal('every ingredient needs an id (a short word such as "curd")')
        if one['id'] in seen:
            raise Refusal(f'two ingredients share the id {one["id"]}: give each its own')
        seen.add(one['id'])
        fdc = None if one.get('fdc_id') is None else str(one['fdc_id'])
        if fdc is not None and not one.get('dataset'):
            raise Refusal(f'ingredient {one["id"]} names fdc_id {fdc} but no dataset: say which of datasets it is in')
        grams = None if one.get('grams') is None else float(one['grams'])
        portion = one.get('portion')
        if grams is None and portion:
            src = dataset(tables, portion.get('dataset', one.get('dataset')), one['id'])
            each, _ = portion_g(src, str(portion.get('fdc_id', fdc)), portion['unit_contains'])
            grams = float(portion.get('count', 1)) * each
        if fdc is not None and grams is None:
            raise Refusal(f'ingredient {one["id"]} has an fdc_id but no grams: give grams, or a portion (unit_contains, count)')
        scale = 1.0 if one.get('scale') is None else float(one['scale'])
        label = one.get('scale_to_label')
        if fdc is not None and label:
            if label.get('nutrient') not in KEYS:
                raise Refusal(f'ingredient {one["id"]}: scale_to_label.nutrient must be one of {", ".join(sorted(KEYS))}')
            p100 = per100(dataset(tables, one['dataset'], one['id']), fdc)
            if not p100[label['nutrient']]:
                raise Refusal(f'ingredient {one["id"]}: food {fdc} has no {label["nutrient"]} to scale to the label')
            scale = float(label['amount']) / (p100[label['nutrient']] * grams / 100)
        ingredients.append(dict(one, id=one['id'], grams=grams, fdc=fdc, db=one.get('dataset'), scale=scale,
                                scaled_to_label=bool(fdc is not None and label)))
    return ingredients


def work_out(request, tables, built):
    ingredients = ingredients_of(request, tables)
    base = [ing['id'] for ing in ingredients if ing.get('base')]
    caveats = request.get('nutrient_caveats') or {}

    totals = {key: 0.0 for key, *_ in NUTS}
    unknown = {key: [] for key, *_ in NUTS}
    per_ing = {}
    mass = 0.0
    for ing in ingredients:
        if ing['fdc'] is None:
            continue
        src = dataset(tables, ing['db'], ing['id'])
        p = per100(src, ing['fdc'])
        mass += ing['grams']
        contrib = {}
        for key, *_ in NUTS:
            if p[key] is None:
                unknown[key].append(ing['id']); continue
            v = p[key] * ing['grams'] / 100 * ing['scale']
            contrib[key] = round(v, 4); totals[key] += v
        per_ing[ing['id']] = contrib
    if mass <= 0:
        raise Refusal('no ingredient with an fdc_id has any grams, so there is no mix to divide by: give at least one')

    profile = []
    for key, label, unit, _ in NUTS:
        t = totals[key]
        row = dict(key=key, nutrient=label, unit=unit, per_batch=round(t, 3), per_100g=round(t / mass * 100, 3),
                   ingredients_without_data=unknown[key])
        if key in DRI:
            m, f, kind = DRI[key]
            row.update(dri_kind=kind, dri_male_19_30=m, dri_female_19_30=f,
                       pct_dri_male=round(t / m * 100, 1), pct_dri_female=round(t / f * 100, 1))
            pm = min(row['pct_dri_male'], row['pct_dri_female'])
            row['flag'] = 'gap' if pm < 10 else 'low' if pm < 33 else 'meets_a_third_or_more' if pm < 100 else 'meets_full_day'
            if key in DOSE_MAX: row['flag'] = 'not_a_gap_sodium_is_a_limit'
            if any(i in unknown[key] for i in base):
                row['flag'] = 'unknown_lower_bound_only'
                row['caveat'] = 'USDA has no value for %s; the figure counts the other ingredients only' % ', '.join(unknown[key])
        if key in caveats:
            row['caveat'] = caveats[key]
        profile.append(row)

    scale_factors = {ing['id']: ing['scale'] for ing in ingredients if ing['scaled_to_label']}
    cross = dict(request.get('cross_check') or {})
    cross['this_model'] = dict(kcal=round(totals['energy'], 1), protein_g=round(totals['protein'], 1))
    out = dict(
        id=request['id'], built=built, basis=request.get('basis', 'per_batch = the whole batch; per_100g over mix mass'),
        mix_mass_g=round(mass, 1), cross_check=cross, nutrients=profile, per_ingredient_contribution_per_batch=per_ing,
        dri_source='NASEM Dietary Reference Intakes summary tables, adults 19-30 (male/female); sodium AI 1500 mg shown for reference, the limit is CDRR 2300 mg; transcribed, not re-fetched',
        food_data_sources={i['id']: dict(fdc_id=i['fdc'], dataset=i['db']) for i in ingredients if i['fdc']},
        scale_factors={k: round(v, 4) for k, v in scale_factors.items()})

    recipe_ings = []
    for i in ingredients:
        item = dict(id=i['id'], name=i.get('name'), amount=i.get('amount'), grams_used_in_profile=(round(i['grams'], 1) if i['grams'] else None))
        for extra in ('amount_status', 'evidence'):
            if extra in i:
                item[extra] = i[extra]
        if 'modelling_note' in i:
            item['modelling_note'] = fill(i['modelling_note'], scale=scale_factors.get(i['id']))
        recipe_ings.append(item)
    recipe = dict(id=request['id'], title=request.get('title'), built=built)
    if 'yield_note' in request:
        recipe['yield_note'] = fill(request['yield_note'], mix_g=mass)
    recipe['ingredients'] = recipe_ings
    for k, v in (request.get('recipe_notes') or {}).items():
        if k not in recipe:
            recipe[k] = v

    lines = ['%-30s %9.2f %-3s  %%DRI m/f: %s' % (r['nutrient'], r['per_batch'], r['unit'], (r.get('pct_dri_male'), r.get('pct_dri_female'), r.get('flag')))
             + ' ' + (str(r['ingredients_without_data']) if r['ingredients_without_data'] else '') for r in profile]
    lines.append(' '.join(['mass', str(mass)] + [f'{k} scale {v}' for k, v in scale_factors.items()]
                          + [f'{i["id"]} g {i["grams"]}' for i in ingredients if i.get('portion') and i['grams'] is not None]))
    return dict(profile=out, recipe=recipe, summary_lines=lines)
