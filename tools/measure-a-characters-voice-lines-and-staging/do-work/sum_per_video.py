rows = []
for i, r in cat.items():
    f = os.path.join(D, 'voice', i + '.turns.json')
    if not os.path.exists(f): continue
    h = json.load(open(f)); dur = h['duration_s']; T = h['turns']
    open_s = sum(min(b, 300) - a for a, b in T if a < 300)                      # first 5 minutes: cold open + sponsor sketch
    out_s = sum(b - max(a, dur - 240) for a, b in T if b > dur - 240)          # last 4 minutes: outro, plugs
    body = [(a, b) for a, b in T if a >= 300 and b <= dur - 240]
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
                     ex_per_10min=round(len(ex) / max((dur - 540) / 600, 0.1), 2),
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
print('low', len(lo), round(st.median(lo), 2), '| mid', len(mi), round(st.median(mi), 2), '| high', len(hi), round(st.median(hi), 2))
s25 = [x for x in ep if x['date'][:6] >= '202503' and x['date'][:6] <= '202508']
print('\n2025-03..08 episodes: stripped vs full (x baseline, character s, dur)')
for x in sorted(s25, key=lambda x: x['date']): print(x['date'], x['id'], 'STRIPPED' if x['stripped'] else '        ', x['xb'], x['character_s'], int(x['dur']))
a = [x['xb'] for x in s25 if x['stripped']]; b = [x['xb'] for x in s25 if not x['stripped']]
print('stripped median', st.median(a) if a else '', len(a), '| full median', st.median(b) if b else '', len(b))
print('\nLOWEST character seconds among episodes from 2024 on:')
for x in sorted([x for x in ep if x['year'] >= '2024'], key=lambda x: x['character_s'])[:12]: print(x['date'], x['id'], x['character_s'], x['xb'], x['title'][:50])
