    for e in d['entries']:
        infos = [os.path.join(YT, d, f"{e['id']}.info.json") for d in ('captions', 'videos', 'comments')]
        info = next((f for f in infos if os.path.exists(f)), '')
        ud = None; likes = comments = None
        if info:
            j = json.load(open(info)); ud = j.get('upload_date'); likes = j.get('like_count'); comments = j.get('comment_count')
        if not ud and e.get('timestamp'):
            ud = datetime.datetime.utcfromtimestamp(e['timestamp']).strftime('%Y%m%d') + '~'
        rows.append(dict(id=e['id'], kind=kind, date=ud or '', views=e.get('view_count') or 0,
                         dur=int(e['duration']) if e.get('duration') else '', title=e.get('title') or '',
                         format=fmt(e.get('title') or '', kind, e.get('duration'), e.get('view_count')), likes=likes or '', comments=comments or ''))
# baseline: median views of the 20 nearest same-format videos in upload order (flat order is newest first)
for f in set(r['format'] for r in rows):
    seq = [r for r in rows if r['format'] == f]
    for i, r in enumerate(seq):
        nb = [x['views'] for j, x in enumerate(seq) if j != i and abs(j - i) <= 10 and x['views']]
        base = statistics.median(nb) if nb else 0
        r['baseline'] = int(base); r['x_baseline'] = round(r['views'] / base, 2) if base else ''
with open(OUT, 'w') as o:
    cols = ['id', 'kind', 'format', 'date', 'views', 'baseline', 'x_baseline', 'dur', 'likes', 'comments', 'title']
    o.write('\t'.join(cols) + '\n')
    for r in rows:
        o.write('\t'.join(str(r[c]).replace('\t', ' ') for c in cols) + '\n')
print(OUT, len(rows))
