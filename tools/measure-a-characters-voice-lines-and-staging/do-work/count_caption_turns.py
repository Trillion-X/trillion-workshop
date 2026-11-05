"""Second, independent count of the character's lines for episodes whose captions carry '>>' speaker-change marks
(YouTube's newer auto-captions): each '>>' turn whose median window pitch is at least RATIO x the episode median pitch
counts as the character's turn. No speaker model involved. Compare with do-work/find_voice.py.
One JSON request on standard input: {data_folder, youtube_folder, extra_voice_folders?, ratio?, settings_record?,
settings?}. Reads <data_folder>/catalog.tsv, <youtube_folder>/captions/<id>.en.json3 and the <id>.emb.npz in
<data_folder>/voice (or the first of extra_voice_folders that holds one); RATIO is ratio, else the settings'
caption_turn_pitch_ratio. Writes <data_folder>/character-caption-turns.tsv; {"result": ...} is the last line printed."""
import os, sys, glob, csv, numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
from shared import events, request, needed, answer
req, s = request(['caption_turn_pitch_ratio'])
RATIO = float(req.get('ratio') or s['caption_turn_pitch_ratio'])
D, YT = needed(req, 'data_folder', 'youtube_folder')
cat = {r['id']: r for r in csv.DictReader(open(os.path.join(D, 'catalog.tsv')), delimiter='\t')}
out = []
for vid, r in cat.items():
    if r['format'] != 'episode': continue
    fs = sorted(glob.glob(os.path.join(YT, 'captions', vid + '.en.json3')))
    npz = [p for p in [os.path.join(D, 'voice', vid + '.emb.npz')] + [os.path.join(v, vid + '.emb.npz') for v in req.get('extra_voice_folders') or []] if os.path.exists(p)]
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
answer({'table': os.path.join(D, 'character-caption-turns.tsv'), 'videos': len(out)})
