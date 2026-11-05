    for c in hf:
        rows.append([d['id'], c.get('id'), c.get('like_count') or 0, c.get('timestamp') or '',
                     re.sub(r'[\t\r\n\u2028\u2029]+', ' / ', c.get('text') or '')])
with open(os.path.join(OUT, 'comments-character.tsv'), 'w') as o:
    o.write('video\tcomment_id\tlikes\ttimestamp\ttext\n')
    for r in sorted(rows, key=lambda r: -r[2]):
        o.write('\t'.join(map(str, r)) + '\n')
with open(os.path.join(OUT, 'comments-summary.tsv'), 'w') as o:
    o.write('video\tupload_date\tviews\tcomment_count\ttop_comments_read\thf_comments\thf_share\thf_like_share\thf_in_top20\ttitle\n')
    for s in summary:
        o.write('\t'.join(map(str, s)) + '\n')
for s in summary: print(*s, sep='\t')
print('total read', sum(s[4] for s in summary), 'hf', sum(s[5] for s in summary))
