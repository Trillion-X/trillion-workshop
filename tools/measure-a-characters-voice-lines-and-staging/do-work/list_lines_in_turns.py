cat = {r['id']: r for r in csv.DictReader(open(os.path.join(D, 'catalog.tsv')), delimiter='\t')}
def capfile(i):
    for d in ('captions', 'videos'):
        for pat in (f'{i}.en.json3', f'{i}.en-orig.json3', f'{i}.en*.json3'):
            fs = sorted(glob.glob(os.path.join(HOME, 'library', 'youtube', d, pat)))
            if fs: return fs[0]
    for f in glob.glob(os.path.join(D, '..', 'raw', f'{i}.en.json3')): return f
n = 0
with open(os.path.join(D, 'character-lines.tsv'), 'w') as o:
    o.write('id\tdate\tformat\tsecond\tturn_start\tturn_end\ttext\n')
    for f in sorted(glob.glob(os.path.join(D, 'voice', '*.turns.json'))):
        r = json.load(open(f)); i = r['id']; c = capfile(i)
        if not c: continue
        ev = events(c)
        for k, (s, d, x) in enumerate(ev):
            e = ev[k + 1][0] if k + 1 < len(ev) else s + d
            for a, b in r['turns']:
                if min(e, b) - max(s, a) >= 0.5 * max(e - s, 0.1):
                    o.write(f"{i}\t{cat.get(i, {}).get('date', '')}\t{cat.get(i, {}).get('format', '')}\t{int(s)}\t{a}\t{b}\t{x}\n"); n += 1
                    break
print(n, 'lines')
