"""Verify: each applied playlist's count == plan, is public, and Watch Later counts == the read. Also writes INDEX.md and watch-later-all.tsv.

Request: {"cookies": FILE, "plan_file": FILE, "applied_file": FILE, "accounts_dir": DIR, "tsv_file": FILE}
Writes verification.json and INDEX.md into accounts_dir (where read_channel.py wrote each channel's lists), and a table of
every Watch Later video with the playlists it is in to tsv_file (default: watch-later-all.tsv beside accounts_dir).
Ported from launch-video tools/yt-library/verify_sort.py, whose folders were fixed paths.
"""
import sys, os, json
import urllib.request, html as _h
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import youtube_client as ytc  # noqa: E402
from youtube_client import Refusal, answer, client_for, playlist_items  # noqa: E402


def run(req):
    for k in ('cookies', 'plan_file', 'applied_file', 'accounts_dir'):
        if not req.get(k):
            raise Refusal(f'name {k}: cookies, plan_file, applied_file (from apply_sort.py) and accounts_dir (from read_channel.py)')
    ACC = req['accounts_dir']
    plan = json.load(open(req['plan_file'])); app = json.load(open(req['applied_file']))
    res = []; idx = ['# YouTube playlists made from Watch Later\n', 'Built by `tools/sort-youtube-watch-later-into-playlists/` from each channel\'s Watch Later (never modified). Plan: `SORT-PLAN.md`; record of what was created: `applied.json`.\n']
    membership = {}  # (slug,id) -> [playlist titles]
    for a in plan['accounts']:
        c = client_for(req['cookies'], a)
        wl, _h2, _r = playlist_items(c, 'VLWL')
        before = json.load(open(f'{ACC}/{a["slug"]}/watch-later.json'))['count']
        ok_wl = len(wl) == before
        idx.append(f'\n## {a["channel"]} ({a["email"]})\nWatch Later: {before} at read, {len(wl)} at verify ({"unchanged" if ok_wl else "CHANGED"}).\n')
        idx.append('| playlist | public URL | videos | purpose |\n|---|---|---|---|')
        res.append({'account': a['slug'], 'watch_later_before': before, 'watch_later_after': len(wl), 'watch_later_unchanged': ok_wl, 'playlists': []})
        for pl in a['playlists']:
            rec = app['accounts'].get(a['slug'], {}).get('playlists', {}).get(pl['key'])
            if not rec or not rec.get('id'):
                res[-1]['playlists'].append({'title': pl['title'], 'id': None, 'planned': len(pl['items']), 'actual': 0, 'public': False, 'count_ok': False}); continue
            items, hdr, raw = playlist_items(c, 'VL' + rec['id'])
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
    tsv = req.get('tsv_file') or os.path.join(os.path.dirname(os.path.abspath(ACC)), 'watch-later-all.tsv')
    lines = ['url\taccount\tplaylists\ttitle\tchannel']
    for a in plan['accounts']:
        for it in json.load(open(f'{ACC}/{a["slug"]}/watch-later.json'))['items']:
            lines.append('\t'.join([it['url'], a['slug'], ' | '.join(membership.get((a['slug'], it['id']), [])), (it['title'] or '').replace('\t', ' '), (it['channel'] or '').replace('\t', ' ')]))
    with open(tsv, 'w') as f: f.write('\n'.join(lines) + '\n')
    bad = [(r['account'], p['title'], p['planned'], p['actual'], p['public']) for r in res for p in r['playlists'] if not (p['count_ok'] and p['public'])]
    return {'watch_later': [{'account': r['account'], 'before': r['watch_later_before'], 'after': r['watch_later_after']} for r in res],
            'problems': [dict(zip(('account', 'title', 'planned', 'actual', 'public'), b)) for b in bad],
            'verification': ACC + '/verification.json', 'index': ACC + '/INDEX.md', 'table': tsv}


if __name__ == '__main__':
    sys.exit(answer(run))
