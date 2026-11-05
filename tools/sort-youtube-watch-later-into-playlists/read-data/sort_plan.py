import sys, os, re, json
import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[2])  # this repository, wherever this place keeps it
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ACC = os.path.expanduser(CHECKOUT + '/library/youtube/accounts')

def views_n(v):
    m = re.match(r'([\d.,]+)\s*([KMB]?)\s+views', v or '')
    if not m: return 0
    return float(m.group(1).replace(',', '')) * {'': 1, 'K': 1e3, 'M': 1e6, 'B': 1e9}[m.group(2)]

def classify_rules(slug):
    cfg = json.load(open(f'{os.path.dirname(os.path.abspath(__file__))}/rules/{slug}.json'))
    items = json.load(open(f'{ACC}/{slug}/watch-later.json'))['items']
    hold = re.compile(cfg['hold_back'])
    rules = []
    for r in cfg['rules']:
        rules.append((r, re.compile(r['channels'].lstrip('^')) if r.get('channels') else None,
                      re.compile(r'\b(?:' + r['strong'] + ')') if r.get('strong') else None, re.compile(r'\b(?:' + r['weak'] + ')') if r.get('weak') else None))
    pls = {r['key']: {'key': r['key'], 'title': r['title'], 'description': r['description'], 'items': []} for r in cfg['rules']}
    unsorted, held = [], []
    for it in items:
        if hold.search(it['title'] or ''):
