CAP = os.path.join(HOME, 'library', 'youtube', 'captions')
cat = {r['id']: r for r in csv.DictReader(open(os.path.join(D, 'catalog.tsv')), delimiter='\t')}
terms = {k: re.compile(v, re.I) for k, v in json.load(open(os.path.join(D, 'lore-terms.json'))).items()}
hits = {k: [] for k in terms}
done = 0
for vid, row in cat.items():
    fs = sorted(glob.glob(os.path.join(CAP, vid + '.en.json3'))) or sorted(glob.glob(os.path.join(CAP, vid + '.en*.json3')))
    if not fs: continue
    done += 1
    ev = events(fs[0])
    for i, (t, d, x) in enumerate(ev):
        ctx = ' '.join(e[2] for e in ev[max(0, i - 1):i + 2])
        for k, rx in terms.items():
            if rx.search(x):
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
