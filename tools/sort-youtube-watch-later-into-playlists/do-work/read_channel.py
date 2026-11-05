]
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
if __name__ == '__main__':
    only = sys.argv[1:] 
    for slug, au, pid, label, _ in CHANNELS:
        if only and slug not in only: continue
        d = os.path.join(OUT, slug); os.makedirs(d, exist_ok=True)
        c = Client(au, pid)
        wl, hdr, _r = playlist_items(c, 'VLWL')
        json.dump({'channel': label, 'authuser': au, 'count': len(wl), 'items': wl}, open(d + '/watch-later.json', 'w'), indent=1, ensure_ascii=False)
        s = subs(c); json.dump({'channel': label, 'count': len(s), 'items': s}, open(d + '/subscriptions.json', 'w'), indent=1, ensure_ascii=False)
        p = playlists(c); json.dump({'channel': label, 'count': len(p), 'items': p}, open(d + '/playlists.json', 'w'), indent=1, ensure_ascii=False)
        print(slug, 'WL', len(wl), 'subs', len(s), 'playlists', len(p), flush=True)
