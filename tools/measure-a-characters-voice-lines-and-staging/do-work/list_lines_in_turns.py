"""Every caption line spoken inside a detected turn of the character, for quoting (id, caption-line start second, text).
A caption line counts when at least half of it lies inside a turn. Lines are auto-captions: spelling is YouTube's.
One JSON request on standard input: {data_folder, youtube_folder}. Reads <data_folder>/catalog.tsv and every
<data_folder>/voice/<id>.turns.json (do-work/find_voice.py); a video's captions are the first of
<youtube_folder>/{captions,videos}/<id>.en.json3, .en-orig.json3, .en*.json3, then <data_folder>/../raw/<id>.en.json3.
Writes <data_folder>/character-lines.tsv; {"result": ...} is the last line printed."""
import os, sys, json, glob, csv
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
from shared import events, request, needed, answer
req, s = request([])
D, YT = needed(req, 'data_folder', 'youtube_folder')
cat = {r['id']: r for r in csv.DictReader(open(os.path.join(D, 'catalog.tsv')), delimiter='\t')}
def capfile(i):
    for d in ('captions', 'videos'):
        for pat in (f'{i}.en.json3', f'{i}.en-orig.json3', f'{i}.en*.json3'):
            fs = sorted(glob.glob(os.path.join(YT, d, pat)))
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
answer({'table': os.path.join(D, 'character-lines.tsv'), 'lines': n})
