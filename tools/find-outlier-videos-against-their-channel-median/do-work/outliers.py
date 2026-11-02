"""Score every titled row of all-videos.tsv against its own source median (bank method:
outlier = views / source median >= 5 and views >= 10,000). Writes outliers.tsv."""
import csv, statistics, sys
from collections import defaultdict
src, out = sys.argv[1], sys.argv[2]
rows = []
with open(src, newline='') as f:
    r = csv.reader(f, delimiter='\t')
    header = next(r)
    for line in r:
        if len(line) < 8 or not line[4].strip().isdigit() or not line[7].strip():
            continue
        rows.append(line)
by = defaultdict(list)
for x in rows:
    by[x[0]].append(int(x[4]))
med = {k: statistics.median(v) for k, v in by.items()}
with open(out, 'w', newline='') as f:
    w = csv.writer(f, delimiter='\t')
    w.writerow(['ratio', 'views', 'kind', 'channel', 'source', 'median', 'n', 'url', 'title'])
    for x in rows:
        m = med[x[0]]
        v = int(x[4])
        if m and v >= 10000 and v / m >= 5:
            w.writerow([f'{v/m:.1f}', v, x[1], x[6], x[0], int(m), len(by[x[0]]), x[3], x[7]])
