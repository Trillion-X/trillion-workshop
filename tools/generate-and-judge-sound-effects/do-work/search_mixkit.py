"""List Mixkit sound effects on Mixkit tag pages for every category in a query file.

Query file (JSON): {"<category>": {"tags": ["click", "keyboard"], "max_s": 3}, ...}
Writes <out>: {"<category>": [ {id, title, duration_s, tag_page, wav_url}, ... ]}. One request every 1.5 s;
pages are parsed as text, nothing is executed. Missing tag pages (404) are reported and skipped.
Usage: python -I search_mixkit.py queries.json candidates.json   (the last line printed is {"result": {"out", "counts"}})
"""
import html
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36'
CARD = re.compile(r'data-audio-player-item-id-value="(\d+)".*?item-grid-card__title">\s*(.*?)\s*</h2>.*?'
                  r'data-test-id="duration">\s*(\d+):(\d+)', re.S)


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8', 'replace')


def main(qpath, opath):
    spec = json.loads(pathlib.Path(qpath).read_text())
    res = {}
    for cat, c in spec.items():
        seen, rows = set(), []
        for tag in c['tags']:
            page = f'https://mixkit.co/free-sound-effects/{tag}/'
            try:
                s = fetch(page)
            except urllib.error.HTTPError as e:
                print(f'{cat}: {tag} -> HTTP {e.code}', file=sys.stderr)
                time.sleep(1.5)
                continue
            n = 0
            for sid, title, mm, ss in CARD.findall(s):
                dur = int(mm) * 60 + int(ss)
                if int(sid) in seen or dur > c['max_s']:
                    continue
                seen.add(int(sid))
                n += 1
                rows.append(dict(id=int(sid), title=html.unescape(title), duration_s=dur, tag_page=page,
                                 wav_url=f'https://assets.mixkit.co/active_storage/sfx/{sid}/{sid}.wav'))
            print(f'{cat}: {tag} -> {n}', file=sys.stderr, flush=True)
            time.sleep(1.5)
        res[cat] = rows
    with open(opath, 'w') as fh:
        json.dump(res, fh, indent=1)
    return {'out': opath, 'counts': {k: len(v) for k, v in res.items()}}


if __name__ == '__main__':
    print(json.dumps({'result': main(*sys.argv[1:3])}))
