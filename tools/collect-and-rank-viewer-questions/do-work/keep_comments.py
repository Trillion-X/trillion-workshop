"""Build the viewer-question library from real YouTube comments.

usage: python3 -I question_library.py <comment-sources.tsv> <comments dir> <buckets.json> <out dir>

Keeps comments that ask a question or state the writer's own situation, tags
each with the AA buckets and slate concepts its words match (rules are DATA in
buckets.json), and writes:
  questions.tsv   every kept comment, most-liked first (evidence: real viewer comment)
  by-concept.md   the 12 most-liked comments per concept, for asker lines and Notion Q&A fields
"""
import csv
import json
import pathlib
import re
import sys


def video_id(url):
    return re.sub(r'.*(v=|shorts/)', '', url.strip())


def main():
    sources, comments_dir, rules_path, out_dir = sys.argv[1:5]
    rules = json.loads(pathlib.Path(rules_path).read_text())
    keep = rules['keep']
    question, situation = re.compile(keep['is_question']), re.compile(keep['is_situation'], re.I)
    aa = {k: re.compile(v, re.I) for k, v in rules['aa_buckets'].items()}
    concepts = {k: re.compile(v, re.I) for k, v in rules['concepts'].items()}
    rows = []
    with open(sources) as f:
        for src in list(csv.DictReader(f, delimiter='\t')):
            path = pathlib.Path(comments_dir) / f"{video_id(src['url'])}.info.json"
            if not path.exists():
                continue
            info = json.loads(path.read_text())
            for c in info.get('comments') or []:
                text = ' '.join((c.get('text') or '').split())
                if not keep['min_chars'] <= len(text) <= keep['max_chars']:
                    continue
                if c.get('parent', 'root') != 'root':
                    continue
                if not (question.search(text) or situation.search(text)):
                    continue
                rows.append({
                    'likes': c.get('like_count') or 0,
                    'kind': 'question' if question.search(text) else 'situation',
                    'aa_buckets': ','.join(k for k, r in aa.items() if r.search(text)),
                    'concepts': ','.join(k for k, r in concepts.items() if r.search(text)),
                    'text': text,
                    'video_title': info.get('title', ''),
                    'channel': info.get('channel', ''),
                    'url': src['url'].strip(),
                    'evidence': 'real viewer comment',
                })
    rows.sort(key=lambda r: -r['likes'])
    out = pathlib.Path(out_dir)
    with open(out / 'questions.tsv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), delimiter='\t')
        w.writeheader()
        w.writerows(rows)
    lines = ['# Real viewer comments per concept (most-liked first)', '',
             f'{len(rows)} kept comments from {len({r["url"] for r in rows})} videos. Source: questions.tsv.', '']
    for cid in concepts:
        hits = [r for r in rows if cid in r['concepts'].split(',')][:12]
        lines += [f'## {cid} ({sum(cid in r["concepts"].split(",") for r in rows)} comments)', '']
        lines += [f'- {r["likes"]} likes, {r["channel"]} "{r["video_title"]}": "{r["text"]}"' for r in hits]
        lines.append('')
    (out / 'by-concept.md').write_text('\n'.join(lines))
    print(f'{len(rows)} comments kept')


main()
