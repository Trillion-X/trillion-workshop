    if not fs or not npz: continue
    ev = events(fs[0])
    if sum('>>' in x for _, _, x in ev) < 5: continue
    d = np.load(npz[0]); t, f, k = d['t'] + 0.75, d['f0'], d['keep'] & (d['f0'] > 0)
    base = float(np.median(f[k]))
    starts = [i for i, e in enumerate(ev) if e[2].startswith('>>')]
    turns = []
    for j, i in enumerate(starts):
        end_i = starts[j + 1] if j + 1 < len(starts) else min(i + 4, len(ev))
        a = ev[i][0]; b = ev[end_i][0] if end_i < len(ev) else ev[-1][0] + ev[-1][1]
        if b - a > 30: b = a + 30                      # a long narration block after a turn is not the turn
        m = k & (t >= a) & (t < b)
        if m.sum() >= 2 and np.median(f[m]) >= RATIO * base:
            turns.append((a, b))
    dur = float(r['dur'] or 0)
    out.append([vid, r['date'], len(starts), len(turns), round(sum(b - a for a, b in turns), 1),
                round(sum(b - a for a, b in turns if a < 300), 1), round(base, 1), r['x_baseline'], r['title'][:60]])
with open(os.path.join(D, 'character-caption-turns.tsv'), 'w') as o:
    o.write('id\tdate\tcaption_turns\tcharacter_turns\tcharacter_s\tcharacter_s_first5min\tepisode_median_f0\tx_baseline\ttitle\n')
    for x in sorted(out, key=lambda x: x[1]): o.write('\t'.join(map(str, x)) + '\n')
for x in sorted(out, key=lambda x: x[1]): print(*x[:8])
