"""The character's numbers over a whole channel from the voice finder (<data_folder>/voice/<id>.turns.json, made by
do-work/find_voice.py) and the catalog (<data_folder>/catalog.tsv, made by do-work/catalog_videos.py).
Writes <data_folder>/character-per-video.tsv and prints the tables by year for the episodes: seconds, turns, share, the
opening (the first opening_seconds), the close (the last closing_seconds), exchanges in the body, the rank correlation
with views against the baseline, the thirds by character seconds, the episodes the character was stripped from
(stripped_ids) against the full ones between compare_from_month and compare_to_month, and the episodes with the least
character time from lowest_from_year.
One JSON request on standard input: {data_folder, settings_record?, settings?}. {"result": ...} is the last line printed."""
import os, json, csv, statistics as st, math, collections
import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
import shared  # noqa: E402
req, S = shared.request(['opening_seconds', 'closing_seconds', 'stripped_ids', 'compare_from_month', 'compare_to_month',
                         'lowest_from_year'])
D, = shared.needed(req, 'data_folder')
OPEN, CLOSE = S['opening_seconds'], S['closing_seconds']
cat = {r['id']: r for r in csv.DictReader(open(os.path.join(D, 'catalog.tsv')), delimiter='\t')}
STRIPPED = set(S['stripped_ids'])
rows = []
for i, r in cat.items():
    f = os.path.join(D, 'voice', i + '.turns.json')
    if not os.path.exists(f): continue
    h = json.load(open(f)); dur = h['duration_s']; T = h['turns']
    open_s = sum(min(b, OPEN) - a for a, b in T if a < OPEN)                    # the opening: cold open + sponsor sketch
    out_s = sum(b - max(a, dur - CLOSE) for a, b in T if b > dur - CLOSE)      # the close: outro, plugs
    body = [(a, b) for a, b in T if a >= OPEN and b <= dur - CLOSE]
    # exchanges in the body: turns closer than 8 s belong to one exchange
    ex = []
    for a, b in body:
        if ex and a - ex[-1][1] <= 8: ex[-1][1] = b; ex[-1][2] += 1
        else: ex.append([a, b, 1])
    gaps = [ex[k + 1][0] - ex[k][1] for k in range(len(ex) - 1)]
    rows.append(dict(id=i, format=r['format'], date=r['date'].rstrip('~'), approx=r['date'].endswith('~'), year=r['date'][:4],
                     views=int(r['views'] or 0), xb=float(r['x_baseline'] or 0), dur=dur, turns=len(T), character_s=h['character_s'],
                     share=h['character_s'] / dur if dur else 0, open_s=round(open_s, 1), outro_s=round(max(out_s, 0), 1),
                     body_s=round(sum(b - a for a, b in body), 1), body_exchanges=len(ex),
                     ex_per_10min=round(len(ex) / max((dur - (OPEN + CLOSE)) / 600, 0.1), 2),
                     median_gap_s=round(st.median(gaps), 1) if gaps else '', median_turn_s=round(st.median([b - a for a, b in T]), 2) if T else '',
                     stripped=i in STRIPPED, title=r['title']))
cols = list(rows[0].keys())
with open(os.path.join(D, 'character-per-video.tsv'), 'w') as o:
    o.write('\t'.join(cols) + '\n')
    for x in sorted(rows, key=lambda x: x['date']): o.write('\t'.join(str(x[c]) for c in cols) + '\n')
ep = [x for x in rows if x['format'] == 'episode']
print('scored', len(rows), 'episodes', len(ep), 'of', sum(1 for r in cat.values() if r['format'] == 'episode'))
print('\nBY YEAR (episodes): n | median character s | median turns | median share | median open s | median body exchanges per 10 min | median gap s | median x baseline')
for y in sorted(set(x['year'] for x in ep)):
    g = [x for x in ep if x['year'] == y]
    md = lambda k: st.median([x[k] for x in g if x[k] != ''])
    print(y, len(g), round(md('character_s'), 1), md('turns'), f"{md('share'):.1%}", md('open_s'), md('ex_per_10min'), md('median_gap_s') if any(x['median_gap_s'] != '' for x in g) else '', md('xb'))
# rank correlation character share vs x baseline, within year (removes the era trend)
def spearman(a, b):
    ra = {v: k for k, v in enumerate(sorted(range(len(a)), key=lambda i: a[i]))}; rb = {v: k for k, v in enumerate(sorted(range(len(b)), key=lambda i: b[i]))}
    n = len(a); d2 = sum((ra[i] - rb[i]) ** 2 for i in range(n)); return 1 - 6 * d2 / (n * (n * n - 1)) if n > 2 else float('nan')
print('\nSPEARMAN character seconds vs x baseline, episodes, per year (n, rho):')
for y in sorted(set(x['year'] for x in ep)):
    g = [x for x in ep if x['year'] == y and not x['approx']]
    if len(g) > 5: print(y, len(g), round(spearman([x['character_s'] for x in g], [x['xb'] for x in g]), 2))
g = [x for x in ep if not x['approx']]
print('all exact-dated', len(g), round(spearman([x['character_s'] for x in g], [x['xb'] for x in g]), 2), '| share:', round(spearman([x['share'] for x in g], [x['xb'] for x in g]), 2))
# terciles of character seconds within year
print('\nTERCILES within year: median x baseline for low / mid / high character seconds')
lo, mi, hi = [], [], []
for y in sorted(set(x['year'] for x in ep)):
    g = sorted([x for x in ep if x['year'] == y], key=lambda x: x['character_s'])
    k = len(g) // 3
    if k < 2: continue
    lo += [x['xb'] for x in g[:k]]; mi += [x['xb'] for x in g[k:len(g) - k]]; hi += [x['xb'] for x in g[len(g) - k:]]
third = lambda x: round(st.median(x), 2) if x else ''   # empty when no year has the six videos thirds need
print('low', len(lo), third(lo), '| mid', len(mi), third(mi), '| high', len(hi), third(hi))
s25 = [x for x in ep if x['date'][:6] >= S['compare_from_month'] and x['date'][:6] <= S['compare_to_month']]
print(f"\n{S['compare_from_month']}..{S['compare_to_month']} episodes: stripped vs full (x baseline, character s, dur)")
for x in sorted(s25, key=lambda x: x['date']): print(x['date'], x['id'], 'STRIPPED' if x['stripped'] else '        ', x['xb'], x['character_s'], int(x['dur']))
a = [x['xb'] for x in s25 if x['stripped']]; b = [x['xb'] for x in s25 if not x['stripped']]
print('stripped median', st.median(a) if a else '', len(a), '| full median', st.median(b) if b else '', len(b))
print(f"\nLOWEST character seconds among episodes from {S['lowest_from_year']} on:")
for x in sorted([x for x in ep if x['year'] >= S['lowest_from_year']], key=lambda x: x['character_s'])[:12]: print(x['date'], x['id'], x['character_s'], x['xb'], x['title'][:50])
shared.answer({'table': os.path.join(D, 'character-per-video.tsv'), 'scored': len(rows), 'episodes': len(ep),
               'stripped_median': st.median(a) if a else None, 'full_median': st.median(b) if b else None})
