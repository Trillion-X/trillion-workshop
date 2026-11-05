totals = {key: 0.0 for key, *_ in NUTS}
unknown = {key: [] for key, *_ in NUTS}
per_ing = {}
mass = 0.0
for ing in ingredients:
    if ing['fdc'] is None:
        continue
    src = srd if ing['db'] == 'sr_legacy' else fod
    p = per100(src, ing['fdc'])
    mass += ing['grams']
    contrib = {}
    for key, *_ in NUTS:
        if p[key] is None:
            unknown[key].append(ing['id']); continue
        v = p[key] * ing['grams'] / 100 * ing['scale']
        contrib[key] = round(v, 4); totals[key] += v
    per_ing[ing['id']] = contrib

DOSE_MAX = {'sodium'}
profile = []
for key, label, unit, _ in NUTS:
    t = totals[key]
    row = dict(key=key, nutrient=label, unit=unit, per_tub=round(t, 3), per_100g=round(t / mass * 100, 3),
               ingredients_without_data=unknown[key])
    if key in DRI:
        m, f, kind = DRI[key]
        row.update(dri_kind=kind, dri_male_19_30=m, dri_female_19_30=f,
                   pct_dri_male=round(t / m * 100, 1), pct_dri_female=round(t / f * 100, 1))
        pm = min(row['pct_dri_male'], row['pct_dri_female'])
        row['flag'] = 'gap' if pm < 10 else 'low' if pm < 33 else 'meets_a_third_or_more' if pm < 100 else 'meets_full_day'
        if key in DOSE_MAX: row['flag'] = 'not_a_gap_sodium_is_a_limit'
        if 'tofu' in unknown[key] or 'soy_milk' in unknown[key]:
            row['flag'] = 'unknown_lower_bound_only'
            row['caveat'] = 'USDA has no value for %s; the figure counts the other ingredients only' % ', '.join(unknown[key])
        if key == 'calcium':
            row['caveat'] = 'depends on the tofu coagulant (calcium sulfate vs nigari) and soy milk fortification, neither read from his labels'
    profile.append(row)
