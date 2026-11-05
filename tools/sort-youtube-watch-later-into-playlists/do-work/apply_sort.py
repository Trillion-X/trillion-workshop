"""Step 4: create public playlists and ADD videos (never removes anything). Idempotent via applied.json + live readback."""
import sys, os, json, time, re
import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[2])  # this repository, wherever this place keeps it
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ytc
from ytc import *
ACC = os.path.expanduser(CHECKOUT + '/library/youtube/accounts')
APPLIED = ACC + '/applied.json'
BATCH = 25
def load():
    return json.load(open(APPLIED)) if os.path.exists(APPLIED) else {'accounts': {}}
def save(a): json.dump(a, open(APPLIED, 'w'), indent=1, ensure_ascii=False)
def existing_playlists(c):
    from read_accounts import playlists
    return playlists(c)
def create(c, title, desc, first_ids):
    r = c.call('playlist/create', {'title': title, 'privacyStatus': 'PUBLIC', 'videoIds': first_ids})
    pid = r.get('playlistId')
    if not pid: raise RuntimeError('create failed: ' + json.dumps(r)[:300])
    if desc:
        c.call('browse/edit_playlist', {'playlistId': pid, 'actions': [{'action': 'ACTION_SET_PLAYLIST_DESCRIPTION', 'playlistDescription': desc}]})
    return pid
def run(only_slug=None, only_title=None, limit_playlists=None):
    plan = json.load(open(ACC + '/sort-plan.json')); app = load(); n_pl = 0
    for acct in plan['accounts']:
        if only_slug and acct['slug'] != only_slug: continue
        c = Client(acct['authuser'], acct['page_id'])
        if re.findall(r'"LOGGED_IN":(\w+)', c.bootstrap()) != ['true']: raise SystemExit('not logged in: run relogin.sh')
        A = app['accounts'].setdefault(acct['slug'], {'channel': acct['channel'], 'playlists': {}})
        try: pre = {p['title']: p['id'] for p in existing_playlists(c)}
        except Exception as e: pre = {}; print('could not list existing playlists', e)
        for pl in acct['playlists']:
            if only_title and pl['title'] != only_title: continue
            if limit_playlists and n_pl >= limit_playlists: return
            n_pl += 1
            rec = A['playlists'].setdefault(pl['key'], {'title': pl['title'], 'id': None, 'added': []})
            ids = [i['id'] for i in pl['items']]
            if not rec['id']:
                if pl['title'] in pre:  # same-titled playlist already exists on this channel: reuse, never duplicate
                    rec['id'] = pre[pl['title']]; rec['reused'] = True
                else:
                    first = ids[:BATCH]
                    rec['id'] = create(c, pl['title'], pl['description'], first); rec['added'] = list(first); save(app)
                    print('created', acct['slug'], pl['title'], rec['id'], flush=True); time.sleep(2)
            have, _h, _r = playlist_items(c, 'VL' + rec['id'])
            haveids = {x['id'] for x in have}
            if not have and rec['added']: raise SystemExit('readback empty for a playlist with recorded items: session lost, aborting to avoid duplicates')
            todo = [i for i in ids if i not in haveids]
            for k in range(0, len(todo), BATCH):
                chunk = todo[k:k + BATCH]
                c.call('browse/edit_playlist', {'playlistId': rec['id'], 'actions': [{'action': 'ACTION_ADD_VIDEO', 'addedVideoId': v} for v in chunk]})
                rec['added'] = sorted(set(rec['added']) | set(chunk)); save(app)
                time.sleep(1.5)
            print('ok', acct['slug'], pl['title'], 'planned', len(ids), 'added now', len(todo), flush=True)
            time.sleep(1)
if __name__ == '__main__':
    run(*(sys.argv[1:2] or [None]), *(sys.argv[2:3] or [None]))
