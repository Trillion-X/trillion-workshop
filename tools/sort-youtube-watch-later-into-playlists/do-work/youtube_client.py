"""A small YouTube InnerTube client that acts as the signed-in channel of a Netscape cookies.txt. Never prints cookie values.

Ported from launch-video tools/yt-library/ytc.py. The cookies file is the request's (load_cookies), not a fixed path; only
youtube.com cookies are sent; a channel's account is found by its sign_in_as (client_for); each command answers one JSON
line (answer).
"""
import os, re, json, time, hashlib, sys, urllib.request, urllib.error
ORIGIN = 'https://www.youtube.com'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'


class Refusal(Exception):
    """A request this tool cannot do, with what to change."""


def read_request():
    """The JSON request on standard input, or a refusal that says how to send one."""
    text = sys.stdin.read()
    try:
        req = json.loads(text) if text.strip() else None
    except json.JSONDecodeError as e:
        raise Refusal(f'the request on standard input is not JSON ({e}): send one JSON object')
    if not isinstance(req, dict):
        raise Refusal('send one JSON object on standard input')
    return req


def answer(run):
    """Run one command: print {"result": ...} or {"error": ...} as the last line (progress lines may come before it)."""
    try:
        result = run(read_request())
    except (Refusal, RuntimeError) as e:
        print(json.dumps({'error': str(e)}))
        return 2
    print(json.dumps({'result': result}, ensure_ascii=False))
    return 0


def _load(path):
    """The cookies a browser sends to www.youtube.com: those of youtube.com only. A google.com cookie of the same
    name (SID, HSID, SAPISID ...) holds another value, and sending it instead makes YouTube answer signed out."""
    jar = {}
    try:
        lines = open(path, encoding='utf8').readlines()
    except OSError as e:
        raise Refusal(f'could not read the cookies file {path} ({e.strerror}): export the browser login with tool:export-browser-login-cookies-for-yt-dlp and pass its file as cookies')
    for l in lines:
        if l.startswith('#HttpOnly_'): l = l[10:]
        f = l.rstrip('\n').split('\t')
        if len(f) >= 7 and (f[0] == 'youtube.com' or f[0].endswith('.youtube.com')):
            jar[f[5]] = f[6]
    return jar
JAR = {}
def load_cookies(path):
    """Read the request's cookies file into JAR, the cookies every Client of this run sends."""
    jar = _load(path)
    if not (jar.get('SAPISID') or jar.get('__Secure-3PAPISID')):
        raise Refusal(f'the cookies file {path} holds no YouTube sign-in (no SAPISID): sign in to YouTube in the browser, then export its login again')
    JAR.clear(); JAR.update(jar)
    return JAR
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
        try:
            self.key = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html).group(1)
            ver = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html).group(1)
        except AttributeError:
            raise Refusal('YouTube\'s page held no InnerTube key: the page shape changed or the request was blocked; try again later')
        self.ctx = {'client': {'clientName': 'WEB', 'clientVersion': ver, 'hl': 'en', 'gl': 'US'}}
        vd = re.search(r'"VISITOR_DATA":"([^"]+)"', html)
        if vd: self.ctx['client']['visitorData'] = vd.group(1)
        self.sess_idx = re.search(r'"SESSION_INDEX":"?(\d+)', html)
        return html
    def signed_in(self):
        return re.findall(r'"LOGGED_IN":(\w+)', self.bootstrap()) == ['true']
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


def client_for(cookies, ch, most=8):
    """A client for one channel of the settings or the plan. The account number (authuser) a browser gives an account
    changes as accounts sign in and out, so a channel naming sign_in_as (the account's email or its channel handle) is
    found by it each run; without it, authuser is used as given."""
    load_cookies(cookies)
    who = ch.get('sign_in_as')
    if not who:
        return Client(ch.get('authuser', 0), ch.get('page_id'))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from list_signed_in_accounts import account_at
    for n in range(most):
        acct = account_at(n)
        if acct.get('email') == who or acct.get('handle') == who:
            return Client(n, ch.get('page_id'))
    raise Refusal(f'no account signed in to this browser login has the email or handle the settings name (sign_in_as) for channel {ch.get("slug")}: sign it in to YouTube in the browser, export the login again, or correct sign_in_as')


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
    """Every video of a playlist (VLWL is Watch Later), page by page; with the header and the last page read."""
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
