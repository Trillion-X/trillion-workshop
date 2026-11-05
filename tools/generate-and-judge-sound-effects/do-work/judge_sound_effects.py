# Judge every forged and generated candidate the way the real palette was judged, pick one per palette sound, and write
# the picked palette (same file names as the reference palette, so a cue plan written for it plays the picks unchanged).
# Per candidate: trim (find + clean edges for one-shot sounds, whole sound for swells), palette format (the palette's
# rate, channels, fade in, fade out and sample peak), then earshot match z for the palette query, realness, measure.
# Lead-ins (the risers) are placed by the cue plan so that they peak on a hit: a riser candidate is cut so its loudest
# moment sits at the same offset as in the real riser, keeping the real riser's length; one that does not build long
# enough before its peak (less than least_build of the real riser's build) is not eligible.
# Pick = highest match z (the criterion the real palette was chosen by) among candidates that are not distorted (at most
# max_saturated of samples at full scale); a sound named in not_from_pick_of must come from another file than that
# sound's pick. The pick is then scaled so its active-part RMS equals the real palette sound's, so the film's cue gains
# mean the same level in A and B.
# usage: EARSHOT_THREADS=3 <earshot venv python> -I do-work/judge_sound_effects.py REQUEST.json [SOUND ...]  (default: all; named
# sounds are redone and merged into the existing results)
#
# REQUEST.json, every path the person's own:
#   sounds              [{name, query}]: the palette sounds and the earshot query that judges each
#   palette             {rate, channels, fade_in_s, fade_out_s, peak_dbfs}: the palette's format
#   reference_folder    the real palette: <name>.wav per sound, the level and lead-in reference and the A of the A/B
#   candidates          {generator: glob}: each generator's candidate files; {sound} and {group} are filled in
#   group_of            {sound: group}: the {group} of a sound (a forge cue type shared by several sounds)
#   about               [JSON-lines logs of {file, prompt, seed}]: what each generated candidate was asked for
#   lead_in, whole      [sound names]: the sounds that lead in to a hit; the sounds trimmed whole (swells and long tails)
#   not_from_pick_of    {sound: other sound}
#   max_saturated       share of samples at full scale above which a candidate is distorted (e.g. 0.001)
#   least_build         share of the reference's build before its peak a lead-in needs (e.g. 0.8)
#   candidates_folder, picked_folder, scores, selection: where the formatted candidates, the picked palette, every
#                       candidate's scores and the picks are written
#   settings_record     optional: the person's record:setting row(s) for this tool (or a JSON file of them); its settings
#                       are the defaults of every key above, the request's own keys over them; film names the film's row
# The last line printed is {"result": {"selection": FILE, "picks": {sound: {generator, match_z}}}}.
import glob
import json
import pathlib
import sys
import numpy as np
import soundfile as sf

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from earshot import api            # noqa: E402
from make_sound_palette import decode            # noqa: E402
from listen_to_sound_effects import refine              # noqa: E402
from listen_to_whole_sounds import whole_trim        # noqa: E402

P = json.loads(pathlib.Path(sys.argv[1]).read_text())
# The person's tuned values (sounds and queries, group_of, lead_in, whole, not_from_pick_of, max_saturated, least_build,
# palette) may come from their settings record (settings_record: the record:setting row as records:read gives it, its value,
# a list of rows, or a JSON file of them), read with the one settings reader (tools/settings) at the film's row, then the
# person's, then the account's; the request's own keys win.
if P.get('settings_record'):
    sys.path.insert(0, str(HERE.parents[1] / 'settings' / 'read-data'))
    import settings   # noqa: E402
    scopes = ([('film', P['film'])] if P.get('film') else []) + [('person', 'me'), ('account', 'main')]
    try:
        tuned = settings.setting(P['settings_record'], HERE.parent.name, scopes)
    except settings.SettingError as e:
        print(json.dumps({'error': f'the settings record could not be read: {e}'}))
        sys.exit(2)
    if not isinstance(tuned, dict):
        print(json.dumps({'error': f"the settings record holds no {HERE.parent.name} row for {', '.join(f'{k} {v}' for k, v in scopes)}: give that row, or the values in the request"}))
        sys.exit(2)
    P = {**tuned, **{k: v for k, v in P.items() if k not in ('settings_record', 'film')}}
SPEC = P['palette']
PAL = pathlib.Path(P['reference_folder'])
CAND = pathlib.Path(P['candidates_folder'])
OUTPAL = pathlib.Path(P['picked_folder'])
MAX_SAT = P['max_saturated']   # a candidate with more than this share of its samples at full scale is distorted: not picked
LEAD_IN = set(P.get('lead_in', []))
WHOLE = set(P.get('whole', []))   # swells and long tails
GROUP = P.get('group_of', {})
meta = {}
for log in P.get('about', []):
    for line in pathlib.Path(log).read_text().splitlines():
        r = json.loads(line)
        meta[r['file']] = r


def candidates(name):
    out = []
    for gen, pattern in P['candidates'].items():
        out += [(gen, f) for f in sorted(glob.glob(pattern.format(sound=name, group=GROUP.get(name, name))))]
    return out


def trim(name, query, f):
    if name in WHOLE:
        a, b = whole_trim(f)[:2]
        return a, b, 'whole'
    seg = api.find(f, query, top=1, kind='event')['segments'][0]
    a, b = refine(f, seg['start'], seg['end'])[:2]
    return a, b, 'find'


def peak_at(x, rate):
    e = np.convolve((x ** 2).mean(1), np.ones(int(0.02 * rate)) / int(0.02 * rate), 'same')
    return int(np.argmax(e))


def lead_in(x, ref, rate):
    """cut x so its peak sits where ref's peaks and it lasts as long as ref; None if x builds for too short a time"""
    pr, px = peak_at(ref, rate), peak_at(x, rate)
    if px < P['least_build'] * pr:
        return None
    a = max(0, px - pr)
    return x[a:a + len(ref)]


def render(x, rate):
    y = x.astype(np.float64)
    fi, fo = int(SPEC['fade_in_s'] * rate), int(SPEC['fade_out_s'] * rate)
    y[:fi] *= np.linspace(0.0, 1.0, fi)[:, None]
    y[-fo:] *= np.linspace(1.0, 0.0, fo)[:, None]
    return y * 10 ** (SPEC['peak_dbfs'] / 20) / np.max(np.abs(y))


def active_rms(y):
    m = np.abs(y).max(1)
    on = m > m.max() * 10 ** (-30 / 20)
    return float(np.sqrt(np.mean(y[on] ** 2)))


rate, ch = SPEC['rate'], SPEC['channels']
only = set(sys.argv[2:])
SEL = pathlib.Path(P['selection'])
SCORES = pathlib.Path(P['scores'])
rows = [r for r in json.loads(SCORES.read_text()) if r['sound'] not in only] if only else []
picks = {k: v for k, v in json.loads(SEL.read_text()).items() if k not in only} if only else {}
for s in P['sounds']:
    name, query = s['name'], s['query']
    if only and name not in only:
        continue
    (CAND / name).mkdir(parents=True, exist_ok=True)
    scored = []
    for gen, f in candidates(name):
        a, b, how = trim(name, query, f)
        x = decode(f, rate, ch)[int(a * rate):int(b * rate)]
        if name in LEAD_IN:
            x = lead_in(x, decode(str(PAL / f'{name}.wav'), rate, ch), rate)
            if x is None:
                continue
            how += '+lead-in'
        if len(x) < int(0.03 * rate):
            continue
        raw, sr0 = sf.read(f, always_2d=True)   # the source as written (ffmpeg's mono-to-stereo upmix lowers the level)
        sat = float((np.abs(raw[int(a * sr0):int(b * sr0)]) >= 0.999).mean())   # pinned at full scale: clipped or tanh-saturated
        out = CAND / name / f"{gen}__{pathlib.Path(f).parent.name}__{pathlib.Path(f).stem}.wav"
        sf.write(out, render(x, rate), rate, subtype='PCM_24')
        m, r, ms = api.match(str(out), query), api.realness(str(out)), api.measure(str(out))
        row = {'sound': name, 'generator': gen, 'source': f, 'file': str(out), 'trim': [a, b], 'trim_how': how,
               'saturated_frac': round(sat, 5), 'match_z': m['z'], 'verdict': m['verdict'], 'p_real': r['p_real'], 'realness': r['verdict'],
               'seconds': round(len(x) / rate, 3), 'lufs': ms.get('lufs'), 'attack_ms': ms.get('attack_ms'),
               'decay_ms': ms.get('decay_ms'), 'centroid_hz': ms.get('centroid_hz'),
               'prompt': meta.get(f, {}).get('prompt'), 'seed': meta.get(f, {}).get('seed')}
        scored.append(row)
        print(f"{name:17s} {gen:6s} {pathlib.Path(out).name[:48]:48s} z {m['z']:+.2f} p_real {r['p_real']:.2f} {row['seconds']} s", file=sys.stderr, flush=True)
    a_ref = str(PAL / f'{name}.wav')
    am, ar = api.match(a_ref, query), api.realness(a_ref)
    taken = picks.get(P.get('not_from_pick_of', {}).get(name), {}).get('source')
    clean = [r for r in scored if r['saturated_frac'] <= MAX_SAT]
    eligible = [r for r in clean if r['source'] != taken]
    if not eligible:
        print(json.dumps({'error': f'{name}: none of its {len(scored)} candidates is clean and eligible; add candidates or raise max_saturated'}))
        sys.exit(2)
    best = max(eligible, key=lambda r: r['match_z'])
    best_by_gen = {g: max((r for r in clean if r['generator'] == g), key=lambda r: r['match_z'], default=None)
                   for g in P['candidates']}
    picks[name] = best
    rows += scored
    y, _ = sf.read(best['file'], always_2d=True)
    ref, _ = sf.read(a_ref, always_2d=True)
    gain = active_rms(ref) / active_rms(y)
    gain = min(gain, 10 ** (-1 / 20) / np.abs(y).max())
    OUTPAL.mkdir(parents=True, exist_ok=True)
    sf.write(OUTPAL / f'{name}.wav', y * gain, rate, subtype='PCM_24')
    ab = api.ab(str(OUTPAL / f'{name}.wav'), a_ref, query=query)
    best.update(level_gain_db=round(20 * np.log10(gain), 2), a_match_z=am['z'], a_p_real=ar['p_real'],
                ab_summary=ab['summary'][:400], best_by_generator={g: (r['match_z'] if r else None) for g, r in best_by_gen.items()},
                best_by_generator_file={g: (r['file'] if r else None) for g, r in best_by_gen.items()})
    print(f"PICK {name}: {best['generator']} z {best['match_z']:+.2f} (A z {am['z']:+.2f}) p_real {best['p_real']:.2f}", file=sys.stderr, flush=True)
SCORES.write_text(json.dumps(rows, indent=1))
SEL.write_text(json.dumps({s['name']: picks[s['name']] for s in P['sounds']}, indent=1))
print(json.dumps({'result': {'selection': str(SEL), 'picks': {k: {'generator': v['generator'], 'match_z': v['match_z']} for k, v in picks.items()}}}))
