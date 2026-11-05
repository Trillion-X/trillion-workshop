"""Verify: each applied playlist's count == plan, is public, and Watch Later counts == Step 2. Also writes accounts/INDEX.md and watch-later-all.tsv."""
import sys, os, json
import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[2])  # this repository, wherever this place keeps it
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ytc
from ytc import *
ACC = os.path.expanduser(CHECKOUT + '/library/youtube/accounts')
plan = json.load(open(ACC + '/sort-plan.json')); app = json.load(open(ACC + '/applied.json'))
res = []; idx = ['# YouTube playlists made from Watch Later\n', 'Built by `tools/yt-library/` from each channel\'s Watch Later (never modified). Plan: `SORT-PLAN.md`; record of what was created: `applied.json`.\n']
membership = {}  # (slug,id) -> [playlist titles]
for a in plan['accounts']:
    c = Client(a['authuser'], a['page_id'])
    wl, _h, _r = playlist_items(c, 'VLWL')
    before = json.load(open(f'{ACC}/{a["slug"]}/watch-later.json'))['count']
    ok_wl = len(wl) == before
    idx.append(f'\n## {a["channel"]} ({a["email"]})\nWatch Later: {before} at read, {len(wl)} at verify ({"unchanged" if ok_wl else "CHANGED"}).\n')
    idx.append('| playlist | public URL | videos | purpose |\n|---|---|---|---|')
    res.append({'account': a['slug'], 'watch_later_before': before, 'watch_later_after': len(wl), 'watch_later_unchanged': ok_wl, 'playlists': []})
    for pl in a['playlists']:
        rec = app['accounts'][a['slug']]['playlists'].get(pl['key'])
        if not rec or not rec.get('id'):
            res[-1]['playlists'].append({'title': pl['title'], 'id': None, 'planned': len(pl['items']), 'actual': 0, 'public': False, 'count_ok': False}); continue
        items, hdr, raw = playlist_items(c, 'VL' + rec['id'])
        s = json.dumps(raw)
        import urllib.request, html as _h
        try:  # anonymous fetch (no cookies): a public playlist shows its title and items to anyone
            t = urllib.request.urlopen(urllib.request.Request('https://www.youtube.com/playlist?list=' + rec['id'], headers={'User-Agent': ytc.UA, 'Accept-Language': 'en-US,en;q=0.9'}), timeout=30).read().decode('utf8', 'replace')
            public = _h.unescape(pl['title']) in _h.unescape(t) or pl['title'].replace('&', '\\u0026') in t
        except Exception: public = False
        res[-1]['playlists'].append({'title': pl['title'], 'id': rec['id'], 'planned': len(pl['items']), 'actual': len(items), 'public': public, 'count_ok': len(items) == len(pl['items'])})
        idx.append(f'| {a["channel"]}: {pl["title"]} | https://www.youtube.com/playlist?list={rec["id"]} | {len(items)} | {pl["description"]} |')
        for i in pl['items']: membership.setdefault((a['slug'], i['id']), []).append(pl['title'])
json.dump(res, open(ACC + '/verification.json', 'w'), indent=1)
open(ACC + '/INDEX.md', 'w').write('\n'.join(idx) + '\n')
# TSV
tsv = os.path.expanduser(CHECKOUT + '/library/youtube/watch-later-all.tsv')
lines = ['url\taccount\tplaylists\ttitle\tchannel']
for a in plan['accounts']:
    for it in json.load(open(f'{ACC}/{a["slug"]}/watch-later.json'))['items']:
        lines.append('\t'.join([it['url'], a['slug'], ' | '.join(membership.get((a['slug'], it['id']), [])), (it['title'] or '').replace('\t', ' '), (it['channel'] or '').replace('\t', ' ')]))
with open(tsv, 'w') as f: f.write('\n'.join(lines) + '\n')
bad = [(r['account'], p['title'], p['planned'], p['actual'], p['public']) for r in res for p in r['playlists'] if not (p['count_ok'] and p['public'])]
print('watch later unchanged:', [(r['account'], r['watch_later_before'], r['watch_later_after']) for r in res]); print('problems:', bad)
