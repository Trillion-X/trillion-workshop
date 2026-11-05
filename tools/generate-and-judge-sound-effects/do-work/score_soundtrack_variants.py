# launch profile (with the picture), timeline sync to the picture's cuts and to the cue frames, realness (information
# only), and a match z at every cue, read twice from the cue frame for the effect's length (max 2 s) against the effect's
# palette query: on the SFX layer alone (sfx_layer.py: the clean reading) and in the full mix (a hint only, earshot
# LIMITS: tags inside a busy mix). A and B are read the same way.
# usage: EARSHOT_THREADS=3 <earshot venv python> -I sfx-ab/ab_score.py NAME=SOUNDTRACK.wav,SFX_LAYER.wav [NAME=...]
import json, pathlib, statistics, sys
import soundfile as sf
from earshot import api
from earshot.critique import critique_text

AB = pathlib.Path(__file__).resolve().parent
ROOT = AB.parents[2]
base = AB / 'base'
pic = str(base / 'raw-16x9.mp4')
plan = json.loads((base / 'cues.json').read_text())
queries = {s['name']: s['query'] for s in json.loads((ROOT / 'tools/sfx-gen/prompts.json').read_text())['sounds']}
pal = ROOT / 'sound/palette'
length = {n: min(2.0, max(0.25, sf.info(str(pal / f'{n}.wav')).duration)) for n in queries}
cue_times = sorted({round(t, 3) for t, _, _ in plan['cues']})
res = json.loads((AB / 'scores.json').read_text()) if (AB / 'scores.json').exists() else {}
for arg in sys.argv[1:]:
    name, paths = arg.split('=', 1)
    path, lay = paths.split(',')
    crit = api.critique(path, video=pic)
    tl = api.timeline(path, video=pic, cues=[{'t': t} for t in cue_times], fresh=True)
    real = api.realness(path)
    per = []
    for t, snd, g in plan['cues']:
        e = min(plan['DUR'], t + length[snd])
        per.append({'t': t, 'sound': snd, 'gain_db': g, 'z_layer': api.match(lay, queries[snd], start=t, end=e)['z'],
                    'z_mix': api.match(path, queries[snd], start=t, end=e)['z']})
    by = {}
    for p in per:
        by.setdefault(p['sound'], []).append(p)
    med = lambda v: round(statistics.median(v), 2)
    res[name] = {'file': path, 'critique_text': critique_text(crit),
                 'critique': {k: crit[k] for k in ('verdict', 'score', 'in_range', 'scored', 'critical_issues', 'major_issues')},
                 'critique_off': [m for m in crit['metrics'] if m.get('status') != 'ok'],
                 'sync': tl.get('sync'), 'realness': {'p_real': real['p_real'], 'verdict': real['verdict']},
                 'sfx_layer': lay, 'cue_z_layer_median': med(p['z_layer'] for p in per),
                 'cue_z_mix_median': med(p['z_mix'] for p in per),
                 'cue_z_by_sound': {k: {'n': len(v), 'layer_median': med(p['z_layer'] for p in v),
                                        'mix_median': med(p['z_mix'] for p in v)} for k, v in sorted(by.items())},
                 'cues': per}
    print(name, '|', crit['verdict'], crit['in_range'], '/', crit['scored'], '| p_real', real['p_real'], '| cue z layer/mix', res[name]['cue_z_layer_median'], res[name]['cue_z_mix_median'], flush=True)
    (AB / 'scores.json').write_text(json.dumps(res, indent=1, default=str))
