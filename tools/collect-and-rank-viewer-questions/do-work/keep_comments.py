"""Keep the video comments that ask a question or state the writer's own situation, and tag each one.

usage: keep_comments.py <comment-sources.tsv> <comments dir> <settings.json> <out dir>

<comment-sources.tsv> has a `url` column (a video's link); <comments dir> holds each video's yt-dlp
`<video id>.info.json` with its comments (tool:keep-channels-latest-videos-and-captions keeps them). Keeps the
top-level comments of the settings' length that ask a question or state the writer's own situation, tags each with
every tag whose words match (the rules are the person's settings row, never code), and writes:
  questions.tsv   every kept comment, most-liked first (evidence: real viewer comment)
  by-concept.md   the most-liked comments of each tag of one tag column, for asker lines and Q&A fields

<settings.json> holds the person's settings row (or the settings), read through tools/settings:
  keep_comments  {min_chars, max_chars, is_question, is_situation}: regexes; is_situation ignores case
  comment_tags   the tag columns in order, {column: {tag: regex}} or [[column, {tag: regex} | [[tag, regex]]]]
                 (the list form keeps the order in a row whose keys are sorted); regexes ignore case
  comment_group_by    the tag column by-concept.md is grouped by (default: the last one)
  comment_group_top   how many comments each tag shows there (default 12)
The last line printed is {"result": {kept, videos, out}}, or {"error": ...} (exit 2).
"""
import csv
import json
import os
import pathlib
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "settings", "read-data"))
import settings as person_settings  # noqa: E402

FOLDER = "collect-and-rank-viewer-questions"
TOOL = "tool:collect-and-rank-viewer-questions"
FIELDS = ['likes', 'kind', '{tags}', 'text', 'video_title', 'channel', 'url', 'evidence']


def fail(words):
    print(json.dumps({"error": words}))
    sys.exit(2)


def settings_from(path):
    """The person's settings for this tool, read through tools/settings: a JSON file holding their list:settings row as
    the door read it ({id, type: "record:setting", value}), or a JSON file of the settings themselves."""
    given = json.load(open(path))
    if not isinstance(given, dict) or not ("value" in given or "records" in given or "settings" in given):
        return given if isinstance(given, dict) else {}
    try:
        if "id" in given and person_settings.parse_id(given["id"])[0] != FOLDER:
            raise person_settings.SettingError(f"{given['id']} holds the settings of another tool: give this tool's own row (record:setting:{FOLDER}~<scope_kind>~<scope_id>).")
        return person_settings.setting(given, FOLDER, default={}, tool=TOOL) or {}
    except person_settings.SettingError as error:
        fail(str(error))


def pairs(value):
    """{name: x} or [[name, x]] or [{name, ...}] as an ordered list of (name, x)."""
    if isinstance(value, dict):
        return list(value.items())
    if isinstance(value, list):
        return [(v["name"], v.get("tags")) if isinstance(v, dict) else tuple(v) for v in value]
    return []


def video_id(url):
    return re.sub(r'.*(v=|shorts/)', '', url.strip())


def main():
    if len(sys.argv) < 5:
        fail("usage: keep_comments.py <comment-sources.tsv> <comments dir> <settings.json> <out dir>")
    sources, comments_dir, rules_path, out_dir = sys.argv[1:5]
    rules = settings_from(rules_path)
    keep = rules.get('keep_comments')
    if not isinstance(keep, dict) or not all(k in keep for k in ('min_chars', 'max_chars', 'is_question', 'is_situation')):
        fail("The settings hold no keep_comments: give {min_chars, max_chars, is_question, is_situation} in the person's settings row.")
    tag_columns = [(column, {k: re.compile(v, re.I) for k, v in pairs(tags)}) for column, tags in pairs(rules.get('comment_tags'))]
    if not tag_columns:
        fail("The settings hold no comment_tags: give {column: {tag: regex}} in the person's settings row.")
    group_by = rules.get('comment_group_by') or tag_columns[-1][0]
    concepts = dict(tag_columns).get(group_by)
    if concepts is None:
        fail(f"comment_group_by names {group_by}, which is not a column of comment_tags.")
    top = int(rules.get('comment_group_top') or 12)
    question, situation = re.compile(keep['is_question']), re.compile(keep['is_situation'], re.I)
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
                row = {
                    'likes': c.get('like_count') or 0,
                    'kind': 'question' if question.search(text) else 'situation',
                }
                for column, tags in tag_columns:
                    row[column] = ','.join(k for k, r in tags.items() if r.search(text))
                row.update({
                    'text': text,
                    'video_title': info.get('title', ''),
                    'channel': info.get('channel', ''),
                    'url': src['url'].strip(),
                    'evidence': 'real viewer comment',
                })
                rows.append(row)
    rows.sort(key=lambda r: -r['likes'])
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    fields = [n for f in FIELDS for n in ([c for c, _ in tag_columns] if f == '{tags}' else [f])]
    with open(out / 'questions.tsv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter='\t')
        w.writeheader()
        w.writerows(rows)
    lines = ['# Real viewer comments per concept (most-liked first)', '',
             f'{len(rows)} kept comments from {len({r["url"] for r in rows})} videos. Source: questions.tsv.', '']
    for cid in concepts:
        hits = [r for r in rows if cid in r[group_by].split(',')][:top]
        lines += [f'## {cid} ({sum(cid in r[group_by].split(",") for r in rows)} comments)', '']
        lines += [f'- {r["likes"]} likes, {r["channel"]} "{r["video_title"]}": "{r["text"]}"' for r in hits]
        lines.append('')
    (out / 'by-concept.md').write_text('\n'.join(lines))
    print(f'{len(rows)} comments kept', file=sys.stderr)
    print(json.dumps({"result": {"kept": len(rows), "videos": len({r["url"] for r in rows}), "out": str(out)}}))


main()
