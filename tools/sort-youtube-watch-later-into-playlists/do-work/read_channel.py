"""Read the Watch Later, subscriptions and playlists of each signed-in channel the request names. Reads only.

Request: {"cookies": FILE, "channels": [{"slug", "label", "sign_in_as" or "authuser", "page_id"}], "out_dir": DIR, "only": [slug, ...]}
Instead of channels, the request may give the person's sort settings (settings_record, their list:settings row as the door
read it, or inline settings): every channel they name is read.
Writes <out_dir>/<slug>/watch-later.json, subscriptions.json and playlists.json; answers with the counts per channel.
Ported from launch-video tools/yt-library/read_accounts.py, whose channels were a list in the code.
"""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import youtube_client as ytc  # noqa: E402
from youtube_client import Refusal, answer, client_for, playlist_items, walk  # noqa: E402


def subs(c):
    r = c.call('browse', {'browseId': 'FEchannels'}); out = []
    while True:
        for cr in walk(r, 'channelRenderer'):
            out.append({'id': cr.get('channelId'), 'title': ytc._txt(cr.get('title')), 'handle': ytc._txt(cr.get('subscriberCountText')),
                        'url': 'https://www.youtube.com/channel/' + cr.get('channelId', '')})
        tok = None
        for cont in walk(r, 'continuationItemRenderer'):
            t = next(walk(cont, 'token'), None)
            if t: tok = t
        if not tok: break
        r = c.call('browse', {'continuation': tok}); time.sleep(0.5)
    return out
def playlists(c):
    r = c.call('browse', {'browseId': 'FEplaylist_aggregation'}); out = []
    while True:
        for lv in list(walk(r, 'lockupViewModel')):
            cid = lv.get('contentId');
            if not cid or lv.get('contentType') != 'LOCKUP_CONTENT_TYPE_PLAYLIST': continue
            title = next(walk(lv, 'title'), {}).get('content')
            badge = next(walk(lv, 'thumbnailBadgeViewModel'), {}).get('text')
            out.append({'id': cid, 'title': title, 'count_text': badge, 'url': 'https://www.youtube.com/playlist?list=' + cid})
        for gp in walk(r, 'gridPlaylistRenderer'):
            out.append({'id': gp['playlistId'], 'title': ytc._txt(gp['title']), 'count_text': ytc._txt(gp.get('videoCountText')), 'url': 'https://www.youtube.com/playlist?list=' + gp['playlistId']})
        tok = None
        for cont in walk(r, 'continuationItemRenderer'):
            t = next(walk(cont, 'token'), None)
            if t: tok = t
        if not tok: break
        r = c.call('browse', {'continuation': tok}); time.sleep(0.5)
    return out


def run(req):
    if not req.get('cookies'):
        raise Refusal('name the cookies file as cookies (made by tool:export-browser-login-cookies-for-yt-dlp)')
    if not req.get('out_dir'):
        raise Refusal('name the folder to write each channel\'s lists into as out_dir')
    channels = req.get('channels') or []
    if not channels and (req.get('settings_record') is not None or req.get('settings') is not None):
        from plan_sort import sort_settings
        channels = sort_settings(req)['channels']
    if not channels:
        raise Refusal('name the channels to read as channels: [{"slug", "label", "sign_in_as" or "authuser", "page_id"}], or give the person\'s sort settings as settings_record')
    OUT, only, read = req['out_dir'], req.get('only') or [], []
    for ch in channels:
        slug, label = ch['slug'], ch['label']
        if only and slug not in only: continue
        d = os.path.join(OUT, slug); os.makedirs(d, exist_ok=True)
        c = client_for(req['cookies'], ch); au = c.authuser
        wl, hdr, _r = playlist_items(c, 'VLWL')
        json.dump({'channel': label, 'authuser': au, 'count': len(wl), 'items': wl}, open(d + '/watch-later.json', 'w'), indent=1, ensure_ascii=False)
        s = subs(c); json.dump({'channel': label, 'count': len(s), 'items': s}, open(d + '/subscriptions.json', 'w'), indent=1, ensure_ascii=False)
        p = playlists(c); json.dump({'channel': label, 'count': len(p), 'items': p}, open(d + '/playlists.json', 'w'), indent=1, ensure_ascii=False)
        read.append({'slug': slug, 'watch_later': len(wl), 'subscriptions': len(s), 'playlists': len(p), 'folder': d})
    return {'channels': read}


if __name__ == '__main__':
    sys.exit(answer(run))
