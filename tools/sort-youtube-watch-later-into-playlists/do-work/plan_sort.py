"""Plan which playlist each Watch Later video goes in, from the person's sort settings. Reads only; changes nothing on YouTube.

Request: {"settings_record": RECORD or FILE, "settings": {"channels": [...]}, "accounts_dir": DIR, "watch_later": {slug: [items]}, "out_dir": DIR}
The sort settings are the person's row record:setting:sort-youtube-watch-later-into-playlists~<scope_kind>~<scope_id> in their
list:settings, given as settings_record exactly as the door read it (or a JSON file holding it), and checked by the one shared
reader, tools/settings; a request may instead give them inline as settings.
Each sorted channel's Watch Later is taken from watch_later, else from <accounts_dir>/<slug>/watch-later.json (do-work/read_channel.py
writes it). With out_dir, writes sort-plan.json and SORT-PLAN.md there; without it, the plan is in the answer.
Ported from launch-video tools/yt-library/plan_sort.py's main (the planner itself is read-data/sort_plan.py).
"""
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
sys.path.insert(0, os.path.join(here, '..', 'read-data'))
sys.path.insert(0, os.path.join(here, '..', '..', 'settings', 'read-data'))
from youtube_client import Refusal, answer  # noqa: E402
from sort_plan import SettingsError, make_plan  # noqa: E402
from read_setting import SettingRefused, settings_of  # noqa: E402

FOLDER = 'sort-youtube-watch-later-into-playlists'


def sort_settings(req):
    """The person's sort settings: from settings_record (their list:settings row, checked), else inline settings."""
    try:
        settings = settings_of(req, FOLDER)
    except SettingRefused as e:
        raise Refusal(str(e))
    if not isinstance(settings.get('channels'), list) or not settings['channels']:
        raise Refusal('the sort settings name no channels: give {"channels": [...]} in the person\'s settings row (or inline settings)')
    return settings


def watch_later_of(req, settings):
    given = req.get('watch_later') or {}
    out = {}
    for ch in settings.get('channels', []):
        if not ch.get('sort'):
            continue
        if ch['slug'] in given:
            out[ch['slug']] = given[ch['slug']]
        elif req.get('accounts_dir'):
            path = os.path.join(req['accounts_dir'], ch['slug'], 'watch-later.json')
            try:
                out[ch['slug']] = json.load(open(path, encoding='utf8'))['items']
            except (OSError, ValueError, KeyError) as e:
                raise Refusal(f'could not read {path} ({e}): read the channel first with do-work/read_channel.py')
    return out


def run(req):
    settings = sort_settings(req)
    try:
        out, md = make_plan(settings, watch_later_of(req, settings), req.get('generated'))
    except SettingsError as e:
        raise Refusal(str(e))
    summary = [{'channel': a['channel'], 'watch_later': a['watch_later_count'], 'unsorted': len(a['unsorted']), 'held_back': len(a['held_back']),
                'playlists': [{'title': p['title'], 'videos': len(p['items'])} for p in a['playlists']]} for a in out['accounts']]
    if not req.get('out_dir'):
        return {'summary': summary, 'plan': out}
    ACC = req['out_dir']; os.makedirs(ACC, exist_ok=True)
    json.dump(out, open(f'{ACC}/sort-plan.json', 'w'), indent=1, ensure_ascii=False)
    open(f'{ACC}/SORT-PLAN.md', 'w').write('\n'.join(md) + '\n')
    for a in out['accounts']:
        print(a['channel'], a['watch_later_count'], 'unsorted', len(a['unsorted']), 'held', len(a['held_back']), file=sys.stderr)
    return {'summary': summary, 'plan_file': os.path.join(ACC, 'sort-plan.json'), 'plan_page': os.path.join(ACC, 'SORT-PLAN.md')}


def main():
    sys.exit(answer(run))
if __name__ == '__main__': main()
