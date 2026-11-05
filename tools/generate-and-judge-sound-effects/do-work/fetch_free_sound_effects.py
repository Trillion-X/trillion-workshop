"""Download the selected SFX candidates, reading each Freesound licence on the sound's own page first.

Selection (JSON): {"<category>": [["freesound", <id>], ["mixkit", <id>], ...], ...}
Candidates come from fs_search.py / mk_search.py output (looked up by id). Freesound items whose page licence is
not CC0 / CC BY 3.0 / CC BY 4.0 are recorded and NOT downloaded. Files go to sound/sfx/<category>/; every entry
(page, author, title, licence as read, description excerpt, date, download URL, local file) goes to
sound/sfx/manifest.json. One request every 1.5 s; downloaded files are data, never executed.
Usage: python -I fetch_sfx.py selection.json
"""
import datetime
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36'
ALLOWED = {'https://creativecommons.org/publicdomain/zero/1.0/': 'CC0 1.0',
           'https://creativecommons.org/licenses/by/4.0/': 'CC BY 4.0',
           'https://creativecommons.org/licenses/by/3.0/': 'CC BY 3.0'}
MIXKIT_LICENCE = ('Mixkit Sound Effects Free License, read 2026-10-16 at https://mixkit.co/license/#sfxFree: '
                  '"Items under the Mixkit Sound Effects Free License can be used in your commercial and '
                  'non-commercial projects for free." No attribution required; no redistribution of the item on '
                  'its own; not to be registered on any rights management service.')


def get(url, binary=False):
    req = urllib.request.Request(urllib.parse.quote(url, safe=':/?=&%'), headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    time.sleep(1.5)
    return data if binary else data.decode('utf-8', 'replace')


def slug(t):
    return re.sub(r'[^a-z0-9]+', '-', t.lower()).strip('-')[:40]


def text(fragment):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', fragment))).strip()


def freesound_page(url):
    s = get(url)
    m = re.search(r'title="Go to the full license text" href="([^"]+)"[^>]*>([^<]+)</a>', s)
    lic_url, lic_name = (m.group(1), m.group(2).strip()) if m else (None, None)
    if lic_url:
        lic_url = 'https://' + lic_url.split('://', 1)[1].rstrip('/') + '/'
    d = re.search(r'(?s)<div[^>]*id="soundDescriptionSection"[^>]*>(.*?)</div>', s) or \
        re.search(r'(?s)<div[^>]*class="[^"]*sound-description[^"]*"[^>]*>(.*?)</div>', s)
    return lic_url, lic_name, text(d.group(1))[:600] if d else ''


def main(sel_path):
    sel = json.load(open(sel_path))
    fs = json.load(open(os.path.join(ROOT, 'sfx', 'freesound', 'candidates.json')))
    mk = json.load(open(os.path.join(ROOT, 'sfx', 'mixkit', 'candidates.json')))
    by_id = {('freesound', r['id']): r for v in fs.values() for r in v}
    by_id.update({('mixkit', r['id']): r for v in mk.values() for r in v})
    mpath = os.path.join(ROOT, 'sfx', 'manifest.json')
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {}
    today = datetime.date.today().isoformat()
    for cat, items in sel.items():
        os.makedirs(os.path.join(ROOT, 'sfx', cat), exist_ok=True)
        for src, sid in items:
            key = f'{src}-{sid}'
            if key in manifest and os.path.exists(manifest[key].get('file') or ''):
                continue
            c = by_id[(src, sid)]
            if src == 'freesound':
                lic_url, lic_name, desc = freesound_page(c['page'])
                e = dict(source='Freesound', id=sid, title=c['title'], author=c['user'], page=c['page'],
                         licence_url=lic_url, licence_seen=f'{lic_name} (sidebar of {c["page"]}, read {today})',
                         description=desc, download_url=c['preview_hq_mp3'], category=cat)
                if lic_url not in ALLOWED:
                    e.update(file=None, blocked=f'licence {lic_name} ({lic_url}) is not CC0 / CC BY')
                    manifest[key] = e
                    print(f'{cat}: {key} BLOCKED {lic_name}', flush=True)
                    continue
                e['licence'] = ALLOWED[lic_url]
                out = os.path.join(ROOT, 'sfx', cat, f'fs-{sid}_{slug(c["title"])}.mp3')
            else:
                e = dict(source='Mixkit', id=sid, title=c['title'], author='Mixkit', page=c['tag_page'],
                         licence='Mixkit Sound Effects Free License', licence_url='https://mixkit.co/license/#sfxFree',
                         licence_seen=MIXKIT_LICENCE, download_url=c['wav_url'], category=cat)
                out = os.path.join(ROOT, 'sfx', cat, f'mk-{sid}_{slug(c["title"])}.wav')
            try:
                data = get(e['download_url'], binary=True)
            except urllib.error.HTTPError as err:
                e.update(file=None, unavailable=f'HTTP {err.code} for {e["download_url"]}')
                manifest[key] = e
                print(f'{cat}: {key} UNAVAILABLE HTTP {err.code}', flush=True)
                continue
            with open(out, 'wb') as fh:
                fh.write(data)
            e['file'] = out
            manifest[key] = e
            print(f'{cat}: {key} {e["licence"]} -> {os.path.basename(out)}', flush=True)
            json.dump(manifest, open(mpath, 'w'), indent=1)
    json.dump(manifest, open(mpath, 'w'), indent=1)


if __name__ == '__main__':
    main(sys.argv[1])
