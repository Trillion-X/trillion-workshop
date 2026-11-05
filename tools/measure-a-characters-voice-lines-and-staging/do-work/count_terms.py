"""Count running jokes, lore names and rituals across every caption file of a channel, with first and last upload date
and one example (id, second, line). The terms are the person's DATA: the settings' terms, {term: regular expression},
matched in any case by the one word judge, tools/judge-words.
One JSON request on standard input: {data_folder, youtube_folder, settings_record?, settings?}. Reads
<data_folder>/catalog.tsv and <youtube_folder>/captions/<id>.en.json3 (else <id>.en*.json3); writes
<data_folder>/lore-terms.tsv; {"result": ...} is the last line printed."""
import json, os, re, glob, csv, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
from shared import events, request, needed, answer, matches, rules_of
req, s = request(['terms'])
D, YT = needed(req, 'data_folder', 'youtube_folder')
CAP = os.path.join(YT, 'captions')
cat = {r['id']: r for r in csv.DictReader(open(os.path.join(D, 'catalog.tsv')), delimiter='\t')}
terms = rules_of(s['terms'])
hits = {k: [] for k in terms}
done = 0
for vid, row in cat.items():
    fs = sorted(glob.glob(os.path.join(CAP, vid + '.en.json3'))) or sorted(glob.glob(os.path.join(CAP, vid + '.en*.json3')))
    if not fs: continue
    done += 1
    ev = events(fs[0])
    said = matches(terms, [x for _, _, x in ev])
    for i, (t, d, x) in enumerate(ev):
        ctx = ' '.join(e[2] for e in ev[max(0, i - 1):i + 2])
        for k in terms:
            if k in said[i]:
                hits[k].append((row['date'], vid, int(t), ctx.replace('>>', '|')[:160]))
with open(os.path.join(D, 'lore-terms.tsv'), 'w') as o:
    o.write('term\tmentions\tvideos\tfirst_date\tlast_date\texample_id\texample_s\texample_text\n')
    for k, h in sorted(hits.items(), key=lambda kv: -len(set(x[1] for x in kv[1]))):
        if not h: o.write(f'{k}\t0\t0\t\t\t\t\t\n'); continue
        h.sort()
        vids = set(x[1] for x in h)
        ex = h[len(h) // 2]
        o.write(f'{k}\t{len(h)}\t{len(vids)}\t{h[0][0]}\t{h[-1][0]}\t{ex[1]}\t{ex[2]}\t{ex[3]}\n')
print('caption files read', done)
answer({'table': os.path.join(D, 'lore-terms.tsv'), 'caption_files': done, 'terms': len(terms)})
