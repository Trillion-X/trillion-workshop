"""Search Freesound's public search pages (CC0 and CC BY only) for every category in a query file.

Query file (JSON): {"<category>": {"queries": ["..."], "max_s": 3.0, "min_s": 0.0}, ...}
Writes <out>: {"<category>": [ {id, user, user_id, title, duration_s, downloads, page, preview_hq_mp3, query,
licence_filter}, ... ]}. One polite request every 1.5 s; pages are parsed as text, nothing is executed.
Usage: python -I search_freesound.py queries.json candidates.json   (the last line printed is {"result": {"out", "counts"}})
"""
import html
import json
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

UA = 'Trillion Workshop sound search (personal research)'
LICENCES = ['Creative Commons 0', 'Attribution']
FIELD = re.compile(r'data-(sound-id|username|user-id|title|duration|num-downloads)="([^"]*)"')


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8', 'replace')


def parse(page):
    out = []
    for block in page.split('class="bw-player"')[1:]:
        f = dict(FIELD.findall(block[:3000]))
        if 'sound-id' not in f:
            continue
        sid, uid = int(f['sound-id']), f['user-id']
        out.append(dict(id=sid, user=f['username'], user_id=uid, title=html.unescape(f.get('title', '')),
                        duration_s=round(float(f.get('duration', 0)), 3), downloads=int(f.get('num-downloads', 0)),
                        page=f"https://freesound.org/people/{f['username']}/sounds/{sid}/",
                        preview_hq_mp3=f'https://cdn.freesound.org/previews/{sid // 1000}/{sid}_{uid}-hq.mp3'))
    return out


def main(qpath, opath):
    spec = json.loads(pathlib.Path(qpath).read_text())
    res = {}
    for cat, c in spec.items():
        seen, rows = set(), []
        for q in c['queries']:
            for lic in LICENCES:
                flt = f'license:"{lic}" duration:[{c.get("min_s", 0)} TO {c["max_s"]}]'
                url = 'https://freesound.org/search/?' + urllib.parse.urlencode(
                    dict(q=q, f=flt, s='Downloads (most first)'))
                try:
                    found = parse(fetch(url))
                except Exception as e:  # noqa: BLE001  (a failed page is reported and skipped)
                    print(f'{cat}: {q} [{lic}] failed: {e}', file=sys.stderr)
                    found = []
                for r in found:
                    if r['id'] not in seen:
                        seen.add(r['id'])
                        rows.append(dict(r, query=q, licence_filter=lic))
                print(f'{cat}: {q!r} [{lic}] -> {len(found)}', file=sys.stderr, flush=True)
                time.sleep(1.5)
        res[cat] = rows
    with open(opath, 'w') as fh:
        json.dump(res, fh, indent=1)
    return {'out': opath, 'counts': {k: len(v) for k, v in res.items()}}


if __name__ == '__main__':
    print(json.dumps({'result': main(*sys.argv[1:3])}))
