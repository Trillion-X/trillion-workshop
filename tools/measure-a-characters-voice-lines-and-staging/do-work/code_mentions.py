}
R = {k: re.compile(v, re.I) for k, v in R.items()}
rows = list(csv.DictReader(open(os.path.join(D, 'comments-character.tsv')), delimiter='\t', quoting=csv.QUOTE_NONE))
cnt, likes = collections.Counter(), collections.Counter()
with open(os.path.join(D, 'comments-character-coded.tsv'), 'w') as o:
    o.write('video\tcomment_id\tlikes\tcodes\ttext\n')
    for r in rows:
        codes = [k for k, rx in R.items() if rx.search(r['text'])] or ['mention-only']
        for c in codes: cnt[c] += 1; likes[c] += int(r['likes'])
        o.write('\t'.join([r['video'], r['comment_id'], r['likes'], ','.join(codes), r['text']]) + '\n')
print('comments', len(rows))
for k, v in cnt.most_common():
    print(f'{k:13s} {v:4d} ({v / len(rows):.0%})  likes {likes[k]}')
