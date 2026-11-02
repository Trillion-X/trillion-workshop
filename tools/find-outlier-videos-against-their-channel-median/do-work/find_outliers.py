"""Score every titled row of a video table against its own source's median views and write the outliers.

A row is an outlier when its views are at least --min-ratio times its source's median (5 by default) and at least
--min-views (10,000 by default). A source's median counts every titled row of that source with a whole-number view count.

usage: python3 -I find_outliers.py <videos.tsv> <outliers.tsv> [--min-ratio 5] [--min-views 10000]
         [--source-col 0] [--kind-col 1] [--url-col 3] [--views-col 4] [--channel-col 6] [--title-col 7]

The table is tab-separated with one header line. Each --*-col is a column number (0 is the first) or a header name.
Writes outliers.tsv (ratio, views, kind, channel, source, median, n, url, title), in the table's order, and prints a
last line {"result": {...}} or {"error": "what to change"}.
"""
import argparse, csv, json, statistics, sys
from collections import defaultdict

COLUMNS = {'source': 0, 'kind': 1, 'url': 3, 'views': 4, 'channel': 6, 'title': 7}


class Refusal(Exception):
    pass


def column_numbers(header, asked):
    """Each wanted column's number, from a number or a header name."""
    numbers = {}
    for name, value in asked.items():
        text = str(value)
        if text.isdigit():
            numbers[name] = int(text)
        elif text in header:
            numbers[name] = header.index(text)
        else:
            raise Refusal(f'--{name}-col {text} is neither a column number nor a header name; the header is: {", ".join(header)}')
    return numbers


def outliers(lines, columns, min_ratio=5.0, min_views=10000):
    """(outlier rows, rows read): each outlier is a dict, in the table's order."""
    need = max(columns.values()) + 1
    rows = []
    for line in lines:
        if len(line) < need or not line[columns['views']].strip().isdigit() or not line[columns['title']].strip():
            continue
        rows.append(line)
    by = defaultdict(list)
    for x in rows:
        by[x[columns['source']]].append(int(x[columns['views']]))
    med = {k: statistics.median(v) for k, v in by.items()}
    found = []
    for x in rows:
        m = med[x[columns['source']]]
        v = int(x[columns['views']])
        if m and v >= min_views and v / m >= min_ratio:
            found.append({'ratio': v / m, 'views': v, 'kind': x[columns['kind']], 'channel': x[columns['channel']],
                          'source': x[columns['source']], 'median': int(m), 'n': len(by[x[columns['source']]]),
                          'url': x[columns['url']], 'title': x[columns['title']]})
    return found, len(rows)


def main(argv):
    p = argparse.ArgumentParser(description='Score titled videos as outliers against their source median.')
    p.add_argument('src')
    p.add_argument('out')
    p.add_argument('--min-ratio', type=float, default=5.0)
    p.add_argument('--min-views', type=int, default=10000)
    for name, number in COLUMNS.items():
        p.add_argument(f'--{name}-col', default=str(number))
    a = p.parse_args(argv)
    try:
        if not a.min_ratio > 0:
            raise Refusal('--min-ratio must be a number above 0')
        try:
            f = open(a.src, newline='')
        except OSError:
            raise Refusal(f'{a.src} is not there: pass the tab-separated video table')
        with f:
            r = csv.reader(f, delimiter='\t')
            header = next(r, None)
            if header is None:
                raise Refusal(f'{a.src} is empty: it needs a header line and one row per video')
            columns = column_numbers(header, {name: getattr(a, f'{name}_col') for name in COLUMNS})
            found, read = outliers(r, columns, a.min_ratio, a.min_views)
    except Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2
    with open(a.out, 'w', newline='') as f:
        w = csv.writer(f, delimiter='\t')
        w.writerow(['ratio', 'views', 'kind', 'channel', 'source', 'median', 'n', 'url', 'title'])
        for o in found:
            w.writerow([f"{o['ratio']:.1f}", o['views'], o['kind'], o['channel'], o['source'], o['median'], o['n'], o['url'], o['title']])
    print(json.dumps({'result': {'outliers': a.out, 'rows_read': read, 'found': len(found),
                                 'sources': len({o['source'] for o in found}), 'min_ratio': a.min_ratio, 'min_views': a.min_views}}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
