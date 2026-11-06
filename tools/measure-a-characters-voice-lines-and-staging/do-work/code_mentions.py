"""Code every comment that names the character with the person's codebook: the settings' codebook, {code: regular
expression}, matched in any case. Multi-label rules, kept as the person's DATA so anyone can re-run them and argue with
them, judged by the one word judge, tools/judge-words; a comment that matches no code is coded mention-only.
One JSON request on standard input: {data_folder, settings_record?, settings?}. Reads <data_folder>/comments-character.tsv
(do-work/collect_mentions.py), writes <data_folder>/comments-character-coded.tsv and prints the counts; {"result": ...}
is the last line printed."""
import csv, os, re, collections
import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
import shared  # noqa: E402
req, s = shared.request(['codebook'])
D, = shared.needed(req, 'data_folder')
R = shared.rules_of(s['codebook'])
rows = list(csv.DictReader(open(os.path.join(D, 'comments-character.tsv')), delimiter='\t', quoting=csv.QUOTE_NONE))
said = shared.matches(R, [r['text'] for r in rows])
cnt, likes = collections.Counter(), collections.Counter()
with open(os.path.join(D, 'comments-character-coded.tsv'), 'w') as o:
    o.write('video\tcomment_id\tlikes\tcodes\ttext\n')
    for r, m in zip(rows, said):
        codes = [k for k in R if k in m] or ['mention-only']
        for c in codes: cnt[c] += 1; likes[c] += int(r['likes'])
        o.write('\t'.join([r['video'], r['comment_id'], r['likes'], ','.join(codes), r['text']]) + '\n')
print('comments', len(rows))
for k, v in cnt.most_common():
    print(f'{k:13s} {v:4d} ({v / len(rows):.0%})  likes {likes[k]}')
shared.answer({'table': os.path.join(D, 'comments-character-coded.tsv'), 'comments': len(rows), 'codes': dict(cnt)})
