ORIGIN = 'https://www.youtube.com'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

def _load():
    jar = {}
    for l in open(COOKIES):
        if l.startswith('#HttpOnly_'): l = l[10:]
        f = l.rstrip('\n').split('\t')
        if len(f) >= 7 and ('youtube.com' in f[0] or 'google.com' in f[0]):
            jar[f[5]] = f[6]
    return jar
JAR = _load()
def cookie_header():
    return '; '.join(f'{k}={v}' for k, v in JAR.items())
def sapisidhash(origin=ORIGIN):
    ts = int(time.time())
    sid = JAR.get('SAPISID') or JAR.get('__Secure-3PAPISID')
    h = hashlib.sha1(f'{ts} {sid} {origin}'.encode()).hexdigest()
    return f'SAPISIDHASH {ts}_{h}'

class Client:
    def __init__(self, authuser=0, page_id=None):
        self.authuser = authuser; self.page_id = page_id
        self.ctx = None; self.key = None
    def _headers(self):
        h = {'User-Agent': UA, 'Cookie': cookie_header(), 'Authorization': sapisidhash(),
             'X-Goog-AuthUser': str(self.authuser), 'X-Origin': ORIGIN, 'Origin': ORIGIN,
             'Content-Type': 'application/json', 'X-Youtube-Bootstrap-Logged-In': 'true',
             'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': '2.20251015.01.00'}
        if self.page_id: h['X-Goog-PageId'] = self.page_id
        return h
    def bootstrap(self):
        req = urllib.request.Request(f'{ORIGIN}/?authuser={self.authuser}', headers={'User-Agent': UA, 'Cookie': cookie_header()})
        html = urllib.request.urlopen(req, timeout=30).read().decode('utf8', 'replace')
        self.key = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html).group(1)
        ver = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html).group(1)
        self.ctx = {'client': {'clientName': 'WEB', 'clientVersion': ver, 'hl': 'en', 'gl': 'US'}}
        vd = re.search(r'"VISITOR_DATA":"([^"]+)"', html)
        if vd: self.ctx['client']['visitorData'] = vd.group(1)
        self.sess_idx = re.search(r'"SESSION_INDEX":"?(\d+)', html)
        return html
    def call(self, endpoint, body, retries=5):
        if not self.ctx: self.bootstrap()
        body = dict(body); ctx = json.loads(json.dumps(self.ctx))
        if self.page_id: ctx['user'] = {'onBehalfOfUser': self.page_id}
        body['context'] = ctx
        for a in range(retries):
            req = urllib.request.Request(f'{ORIGIN}/youtubei/v1/{endpoint}?key={self.key}&prettyPrint=false',
                                         data=json.dumps(body).encode(), headers=self._headers())
            try:
                return json.load(urllib.request.urlopen(req, timeout=60))
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503) and a < retries - 1:
                    time.sleep(5 * (a + 1) ** 2); continue
                raise RuntimeError(f'{endpoint} HTTP {e.code}: {e.read()[:300]!r}')
            except Exception:
                if a == retries - 1: raise
                time.sleep(3 * (a + 1))

def walk(o, key):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key: yield v
            else: yield from walk(v, key)
    elif isinstance(o, list):
        for v in o: yield from walk(v, key)

def _txt(o):
    if not o: return None
    if 'simpleText' in o: return o['simpleText']
    return ''.join(r.get('text','') for r in o.get('runs',[]))
def parse_video(r, pos):
    vid = r.get('videoId')
    dur = r.get('lengthText', {}).get('simpleText') if r.get('lengthText') else None
    return {'position': pos, 'set_id': r.get('setVideoId'), 'id': vid, 'url': f'https://www.youtube.com/watch?v={vid}', 'title': _txt(r.get('title')),
            'channel': _txt(r.get('shortBylineText')) if r.get('shortBylineText') else None,
            'duration': dur, 'duration_seconds': int(r['lengthSeconds']) if r.get('lengthSeconds') else None,
            'views': _txt(r.get('videoInfo')), 'unplayable': 'isPlayable' in r and not r['isPlayable']}
def parse_lockup(lv, pos):
    vid = lv.get('contentId'); md = lv.get('metadata', {}).get('lockupMetadataViewModel', {})
    title = (md.get('title') or {}).get('content')
    rows = next(walk(md, 'metadataRows'), [])
    texts = [[p.get('text', {}).get('content') for p in row.get('metadataParts', [])] for row in rows]
    channel = texts[0][0] if texts and texts[0] else None
    views = ' • '.join(t for row in texts[1:] for t in row if t) or None
    dur = next((b.get('text') for b in walk(lv, 'thumbnailBadgeViewModel') if b.get('text')), None)
    return {'position': pos, 'id': vid, 'url': f'https://www.youtube.com/watch?v={vid}', 'title': title, 'channel': channel,
            'duration': dur, 'duration_seconds': None, 'views': views, 'unplayable': False}
def _tokens(r):
    toks = []
    for k in ('continuationItemRenderer', 'continuationItemViewModel'):
        for cont in walk(r, k):
            t = next(walk(cont, 'token'), None)
            if t: toks.append(t)
    return toks[:1]
def playlist_items(c, browse_id, limit=None):
    out = []; r = c.call('browse', {'browseId': browse_id})
    header = r.get('header') or {}
    while True:
        found = list(walk(r, 'playlistVideoRenderer'))
        for pv in found: out.append(parse_video(pv, len(out) + 1))
        if not found:
            for lv in walk(r, 'lockupViewModel'):
                if lv.get('contentType') == 'LOCKUP_CONTENT_TYPE_VIDEO': out.append(parse_lockup(lv, len(out) + 1))
        toks = _tokens(r)
        if not toks or (limit and len(out) >= limit): break
        r = c.call('browse', {'continuation': toks[0]}); time.sleep(0.5)
    return out, header, r
