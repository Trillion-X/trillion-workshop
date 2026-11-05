"""Staging around the character's turns, measured from a video's picture rhythm and sound timeline
(<youtube_folder>/measure/<id>/rhythm.json and earshot-timeline.txt):
- is there a picture cut within 0.5 s of the turn start (the cutaway to the character or the head turn)?
- median shot length inside the character's exchanges vs the rest of the episode
- do the music stop-downs (earshot GAP lines) cluster just before the character's turns (within 2 s) vs chance?
One JSON request on standard input: {ids, data_folder, youtube_folder}; the turns are <data_folder>/voice/<id>.turns.json
(do-work/find_voice.py). Prints one row per id and adds or updates them in <data_folder>/staging.tsv; {"result": ...}
is the last line printed."""
import os, sys, json, re, statistics, csv
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
from shared import request, needed, answer
req, s = request([])
D, YT, IDS = needed(req, 'data_folder', 'youtube_folder', 'ids')
M = os.path.join(YT, 'measure')
def ts(s):
    p = s.split(':'); return float(p[0]) * 60 + float(p[1]) if len(p) == 2 else float(p[0]) * 3600 + float(p[1]) * 60 + float(p[2])
out, measured = {}, []
p = os.path.join(D, 'staging.tsv')
if os.path.exists(p):
    for r in csv.DictReader(open(p), delimiter='\t'): out[r['id']] = r
for vid in IDS:
    rj = os.path.join(M, vid, 'rhythm.json'); hj = os.path.join(D, 'voice', vid + '.turns.json'); ej = os.path.join(M, vid, 'earshot-timeline.txt')
    if not (os.path.exists(rj) and os.path.exists(hj)): print(vid, 'missing measure or voice'); continue
    try:
        rh = json.load(open(rj)); hf = json.load(open(hj))
    except ValueError:
        print(vid, 'measurement still being written'); continue
    cuts = [s['start'] for s in rh['shots'][1:]]
    turns = hf['turns']
    def near_cut(t, w=0.5): return any(abs(c - t) <= w for c in cuts)
    cut_at_entry = sum(near_cut(a) for a, b in turns)
    # exchanges: turns merged across gaps <= 8 s, padded 2 s
    ex = []
    for a, b in turns:
        if ex and a - ex[-1][1] <= 8: ex[-1][1] = b
        else: ex.append([a, b])
    ex = [[a - 2, b + 2] for a, b in ex]
    inside = [s['end'] - s['start'] for s in rh['shots'] if any(a <= s['start'] < b for a, b in ex)]
    outside = [s['end'] - s['start'] for s in rh['shots'] if not any(a <= s['start'] < b for a, b in ex)]
    gaps = []
    if os.path.exists(ej):
        for line in open(ej):
            m = re.match(r'\s*(\d+:\d{2}(?::\d{2})?\.\d+)\s+GAP\s+drop', line)
            if m: gaps.append(ts(m.group(1)))
    gap_before = sum(any(0 <= a - g <= 2 for g in gaps) for a, b in turns)
    dur = rh['seconds']; chance = min(1.0, len(gaps) * 2 / dur) if dur else 0
    row = {'id': vid, 'turns': len(turns), 'character_s': hf['character_s'], 'cuts_per_min': rh['cuts_per_min'],
           'cut_at_entry_share': round(cut_at_entry / max(len(turns), 1), 2),
           'cut_chance_share': round(min(1.0, len(cuts) * 1.0 / dur), 2),
           'median_shot_in_exchange_s': round(statistics.median(inside), 2) if inside else '',
           'median_shot_elsewhere_s': round(statistics.median(outside), 2) if outside else '',
           'stopdown_before_turn_share': round(gap_before / max(len(turns), 1), 2), 'stopdown_chance_share': round(chance, 2)}
    out[vid] = row
    print(row)
    measured.append(vid)
cols = ['id', 'turns', 'character_s', 'cuts_per_min', 'cut_at_entry_share', 'cut_chance_share', 'median_shot_in_exchange_s',
        'median_shot_elsewhere_s', 'stopdown_before_turn_share', 'stopdown_chance_share']
with open(p, 'w') as o:
    o.write('\t'.join(cols) + '\n')
    for r in out.values(): o.write('\t'.join(str(r.get(c, '')) for c in cols) + '\n')
answer({'table': p, 'measured': measured})
