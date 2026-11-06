"""Create the plan's public playlists and ADD its videos (never removes anything). Idempotent via applied_file + live readback.

Request: {"cookies": FILE, "plan_file": FILE, "applied_file": FILE, "only_slug": slug, "only_title": title, "limit_playlists": N, "batch": 25}
Ported from launch-video tools/yt-library/apply_sort.py, whose plan and record of what was made were fixed paths.
"""
import sys, os, json, time, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from youtube_client import Refusal, answer, client_for, playlist_items  # noqa: E402
APPLIED = None  # the request's applied_file
BATCH = 25
def load():
    return json.load(open(APPLIED)) if os.path.exists(APPLIED) else {'accounts': {}}
def save(a): json.dump(a, open(APPLIED, 'w'), indent=1, ensure_ascii=False)
def existing_playlists(c):
    from read_channel import playlists
    return playlists(c)
def create(c, title, desc, first_ids):
    r = c.call('playlist/create', {'title': title, 'privacyStatus': 'PUBLIC', 'videoIds': first_ids})
    pid = r.get('playlistId')
    if not pid: raise RuntimeError('create failed: ' + json.dumps(r)[:300])
    if desc:
        c.call('browse/edit_playlist', {'playlistId': pid, 'actions': [{'action': 'ACTION_SET_PLAYLIST_DESCRIPTION', 'playlistDescription': desc}]})
    return pid
def apply(plan, cookies, done, only_slug=None, only_title=None, limit_playlists=None):
    app = load(); n_pl = 0
    for acct in plan['accounts']:
        if only_slug and acct['slug'] != only_slug: continue
        c = client_for(cookies, acct)
        if re.findall(r'"LOGGED_IN":(\w+)', c.bootstrap()) != ['true']: raise Refusal('not signed in: export the browser\'s YouTube login again with tool:export-browser-login-cookies-for-yt-dlp')
        A = app['accounts'].setdefault(acct['slug'], {'channel': acct['channel'], 'playlists': {}})
        try: pre = {p['title']: p['id'] for p in existing_playlists(c)}
        except Exception as e: pre = {}; print('could not list existing playlists', e)
        for pl in acct['playlists']:
            if only_title and pl['title'] != only_title: continue
            if limit_playlists and n_pl >= limit_playlists: return
            n_pl += 1
            rec = A['playlists'].setdefault(pl['key'], {'title': pl['title'], 'id': None, 'added': []})
            ids = [i['id'] for i in pl['items']]
            created = False
            if not rec['id']:
                if pl['title'] in pre:  # same-titled playlist already exists on this channel: reuse, never duplicate
                    rec['id'] = pre[pl['title']]; rec['reused'] = True
                else:
                    first = ids[:BATCH]
                    rec['id'] = create(c, pl['title'], pl['description'], first); rec['added'] = list(first); save(app)
                    print('created', acct['slug'], pl['title'], rec['id'], flush=True); time.sleep(2)
                    created = True
            have, _h, _r = playlist_items(c, 'VL' + rec['id'])
            haveids = {x['id'] for x in have}
            if not have and rec['added']: raise Refusal(f'reading back playlist {rec["id"]} found it empty though videos were added: the session was lost; stopped so nothing is added twice. Export the login again, then run again')
            todo = [i for i in ids if i not in haveids]
            for k in range(0, len(todo), BATCH):
                chunk = todo[k:k + BATCH]
                c.call('browse/edit_playlist', {'playlistId': rec['id'], 'actions': [{'action': 'ACTION_ADD_VIDEO', 'addedVideoId': v} for v in chunk]})
                rec['added'] = sorted(set(rec['added']) | set(chunk)); save(app)
                time.sleep(1.5)
            print('ok', acct['slug'], pl['title'], 'planned', len(ids), 'added now', len(todo), flush=True)
            done.append({'slug': acct['slug'], 'title': pl['title'], 'id': rec['id'], 'created': created, 'reused': bool(rec.get('reused')), 'planned': len(ids), 'added_now': len(todo)})
            time.sleep(1)
def run(req):
    global APPLIED, BATCH
    for k in ('cookies', 'plan_file', 'applied_file'):
        if not req.get(k):
            raise Refusal(f'name {k}: cookies (tool:export-browser-login-cookies-for-yt-dlp), plan_file (do-work/plan_sort.py) and applied_file (where what was made is kept)')
    APPLIED, BATCH = req['applied_file'], int(req.get('batch', 25))
    plan = json.load(open(req['plan_file'], encoding='utf8')); done = []
    apply(plan, req['cookies'], done, req.get('only_slug'), req.get('only_title'), req.get('limit_playlists'))
    return {'playlists': done}
if __name__ == '__main__':
    sys.exit(answer(run))
