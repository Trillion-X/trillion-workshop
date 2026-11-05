"""The character in the comments: per video, how many of the downloaded top comments name it, their likes, and the
comments themselves for coding. Reads <youtube_folder>/comments/<id>.info.json (yt-dlp --write-comments). A comment
names the character when the settings' mention_pattern matches it (any case), judged by the one word judge,
tools/judge-words.
Writes <data_folder>/comments-character.tsv (every mentioning comment) and comments-summary.tsv, and prints per-video
counts. One JSON request on standard input: {youtube_folder, data_folder, settings_record?, settings?}; {"result": ...}
is the last line printed."""
import json, os, re, glob, csv
import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
import shared  # noqa: E402
req, S = shared.request(['mention_pattern'])
YT, OUT = shared.needed(req, 'youtube_folder', 'data_folder')
CDIR = os.path.join(YT, 'comments')
rows, summary = [], []
for f in sorted(glob.glob(os.path.join(CDIR, '*.info.json'))):
    d = json.load(open(f))
    cs = [c for c in d.get('comments') or [] if c.get('parent') == 'root']
    said = shared.matches({'mention': S['mention_pattern']}, [c.get('text') or '' for c in cs])
    hf = [c for c, m in zip(cs, said) if m]; named = {id(c) for c in hf}
    likes_all = sum(c.get('like_count') or 0 for c in cs); likes_hf = sum(c.get('like_count') or 0 for c in hf)
    top20 = sorted(cs, key=lambda c: -(c.get('like_count') or 0))[:20]
    summary.append((d['id'], d.get('upload_date'), d.get('view_count'), d.get('comment_count'), len(cs), len(hf),
                    round(len(hf) / max(len(cs), 1), 3), round(likes_hf / max(likes_all, 1), 3),
                    sum(1 for c in top20 if id(c) in named), d.get('title', '')[:60]))
    for c in hf:
        rows.append([d['id'], c.get('id'), c.get('like_count') or 0, c.get('timestamp') or '',
                     re.sub(r'[\t\r\n\u2028\u2029]+', ' / ', c.get('text') or '')])
with open(os.path.join(OUT, 'comments-character.tsv'), 'w') as o:
    o.write('video\tcomment_id\tlikes\ttimestamp\ttext\n')
    for r in sorted(rows, key=lambda r: -r[2]):
        o.write('\t'.join(map(str, r)) + '\n')
with open(os.path.join(OUT, 'comments-summary.tsv'), 'w') as o:
    o.write('video\tupload_date\tviews\tcomment_count\ttop_comments_read\tmentions\tmention_share\tmention_like_share\tmentions_in_top20\ttitle\n')
    for s in summary:
        o.write('\t'.join(map(str, s)) + '\n')
for s in summary: print(*s, sep='\t')
print('total read', sum(s[4] for s in summary), 'mentions', sum(s[5] for s in summary))
shared.answer({'mentions': os.path.join(OUT, 'comments-character.tsv'), 'videos': len(summary),
               'comments_read': sum(s[4] for s in summary), 'mentioning': sum(s[5] for s in summary)})
