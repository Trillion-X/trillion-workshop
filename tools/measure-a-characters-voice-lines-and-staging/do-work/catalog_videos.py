"""Build a channel's video catalog with a format label and performance vs a rolling channel baseline.
Reads <youtube_folder>/flat/<channel>-videos.json and <channel>-shorts.json (yt-dlp flat playlist dumps), and
<youtube_folder>/{captions,videos,comments}/<id>.info.json when present for exact dates, likes and comments.
A video's format: short for the shorts list; the format of the first series_prefixes title start; compilation when the
title has one of compilation_words; members-only with no views; side when side_pattern matches the title or it is under
3 minutes; else episode (the words are the person's settings).
One JSON request on standard input: {youtube_folder, channel, data_folder, settings_record?, settings?}; writes
<data_folder>/catalog.tsv.
{"result": {catalog, videos}} is the last line printed."""
import json, os, re, statistics, datetime
import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
import shared  # noqa: E402
req, S = shared.request(['series_prefixes', 'compilation_words', 'side_pattern'])
YT, CHANNEL, D = shared.needed(req, 'youtube_folder', 'channel', 'data_folder')
OUT = os.path.join(D, 'catalog.tsv')

def fmt(title, kind, dur, views):
    t = title.lower()
    if kind == 'short': return 'short'
    for start, label in S['series_prefixes'].items():
        if t.startswith(start): return label                # a series of its own, by how its titles start
    if any(w in t for w in S['compilation_words']): return 'compilation'
    if not views: return 'members-only'                     # the flat list shows 0 views for members-only uploads
    if re.search(S['side_pattern'], t):
        return 'side'                                       # character pieces, songs, promos, channel notes
    if dur and dur < 180: return 'side'
    return 'episode'

rows = []
for tab, kind in (('videos', 'video'), ('shorts', 'short')):
    d = json.load(open(os.path.join(YT, 'flat', f'{CHANNEL}-{tab}.json')))
    for e in d['entries']:
        infos = [os.path.join(YT, d, f"{e['id']}.info.json") for d in ('captions', 'videos', 'comments')]
        info = next((f for f in infos if os.path.exists(f)), '')
        ud = None; likes = comments = None
        if info:
            j = json.load(open(info)); ud = j.get('upload_date'); likes = j.get('like_count'); comments = j.get('comment_count')
        if not ud and e.get('timestamp'):
            ud = datetime.datetime.fromtimestamp(e['timestamp'], datetime.timezone.utc).strftime('%Y%m%d') + '~'
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
shared.answer({'catalog': OUT, 'videos': len(rows)})
