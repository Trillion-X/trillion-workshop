#!/usr/bin/env python3
"""Check that exact words appear on a source page, and under the named speaker when the page labels its speakers.

One JSON request (a file named as the first argument, or standard input):
  {"checks": [{"id"?: "...", "words": "...", "url": "https://..." | "file": "/abs/path", "speaker_label": "ROGER FEDERER"?}]}
The last line on standard output is {"result": {"checks": [{"id", "found", "speaker_seen", "verified", "bytes", "checked_at"}]}}
or {"error": "..."} with exit status 1. Checks answer in request order; a check with no id takes its index. Other fields
of a check are ignored, so a list of candidates can be passed as it is. Nothing is kept: the answer is the record of the check.
"""
import html, json, re, sys, time, urllib.request

SAME = [('’', "'"), ('‘', "'"), ('“', '"'), ('”', '"'), ('—', '-'), ('–', '-'), ('…', '...'), (' ', ' ')]
LABEL = re.compile(r"([A-Z][A-Z .'\-]{3,}):")


def plain(text):
    """The words a reader sees: scripts, styles and tags removed, entities read, quotes and dashes made one form, spaces collapsed."""
    text = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', text, flags=re.S | re.I)
    text = html.unescape(re.sub(r'<[^>]+>', ' ', text))
    for a, b in SAME:
        text = text.replace(a, b)
    return re.sub(r'\s+', ' ', text).strip()


def read(check, fetch):
    if check.get('file'):
        with open(check['file'], encoding='utf-8', errors='ignore') as f:
            return f.read()
    if check.get('url'):
        return fetch(check['url'])
    raise ValueError(f"check {check.get('id')!r} names no url and no file")


def fetch_url(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (check-words-appear-in-a-source)'})
    with urllib.request.urlopen(request, timeout=40) as answer:
        return answer.read().decode('utf-8', errors='ignore')


def check_one(check, fetch=fetch_url, pages=None):
    pages = {} if pages is None else pages
    key = check.get('file') or check.get('url')
    if key not in pages:
        try:
            pages[key] = read(check, fetch)
        except Exception as error:  # an unreachable page is a failed check, said in its own words
            pages[key] = None
            pages[key + '#error'] = str(error)
    raw = pages[key]
    out = {'id': check.get('id'), 'found': False, 'speaker_seen': None, 'verified': False,
           'bytes': len(raw or ''), 'checked_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    if raw is None:
        out['error'] = pages.get(key + '#error')
        return out
    text, words = plain(raw), plain(check.get('words') or '')
    if not words:
        out['error'] = 'no words to look for'
        return out
    at = text.find(words)
    out['found'] = at >= 0
    if at < 0:
        return out
    wanted = (check.get('speaker_label') or '').strip()
    labels = LABEL.findall(text[:at])
    out['speaker_seen'] = labels[-1].strip() if labels else None
    # A page that labels its speakers in capitals must name the wanted speaker last before the words.
    out['verified'] = not wanted or not labels or not wanted.isupper() or out['speaker_seen'] == wanted
    return out


def main(argv):
    try:
        request = json.load(open(argv[1]) if len(argv) > 1 else sys.stdin)
        checks = request.get('checks')
        if not isinstance(checks, list) or not checks:
            raise ValueError('the request needs checks: a list of {id, words, url or file, speaker_label?}')
        pages = {}
        print(json.dumps({'result': {'checks': [check_one({'id': i, **c}, pages=pages) for i, c in enumerate(checks)]}}))
        return 0
    except Exception as error:
        message = str(error)
        print(message, file=sys.stderr)
        print(json.dumps({'error': message}))
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
