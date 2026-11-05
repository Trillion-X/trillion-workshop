MAX_SAT = 0.001   # a candidate with more than 0.1 % of its samples at full scale is distorted: not picked
LEAD_IN = {'riser-breath', 'riser-cinematic'}
WHOLE = {'whoosh-soft', 'hit-low-space', 'riser-breath', 'riser-cinematic', 'logo-sting'}   # swells and long tails
FORGE = {'key-press-a': 'key', 'key-press-b': 'key', 'tick-counter': 'tick', 'whoosh-soft': 'whoosh',
         'hit-low-space': 'impact', 'hit-low-deep': 'impact', 'chime-glass-done': 'chime',
         'riser-breath': 'riser', 'riser-cinematic': 'riser', 'logo-sting': 'logo'}
meta = {}
for gen in ('sa3', 'moss'):
    for line in open(G / f'out/gen/{gen}.jsonl'):
        r = json.loads(line)
        meta[r['file']] = r


def candidates(name):
    out = [('forge', f) for f in sorted(glob.glob(str(G / f'out/forge/{FORGE[name]}-*/*.wav')))]
    for gen in ('sa3', 'moss'):
        out += [(gen, f) for f in sorted(glob.glob(str(G / f'out/gen/{gen}/{name}/*.wav')))]
    return out


def trim(name, query, f):
    if name in WHOLE:
        a, b = whole_trim(f)[:2]
        return a, b, 'whole'
    seg = api.find(f, query, top=1, kind='event')['segments'][0]
    a, b = refine(f, seg['start'], seg['end'])[:2]
    return a, b, 'find'


def peak_at(x, rate):
    e = np.convolve((x ** 2).mean(1), np.ones(int(0.02 * rate)) / int(0.02 * rate), 'same')
    return int(np.argmax(e))


def lead_in(x, ref, rate):
    """cut x so its peak sits where ref's peaks and it lasts as long as ref; None if x builds for too short a time"""
    pr, px = peak_at(ref, rate), peak_at(x, rate)
    if px < 0.8 * pr:
        return None
    a = max(0, px - pr)
    return x[a:a + len(ref)]


def render(x, rate):
    y = x.astype(np.float64)
    fi, fo = int(SPEC['fade_in_s'] * rate), int(SPEC['fade_out_s'] * rate)
    y[:fi] *= np.linspace(0.0, 1.0, fi)[:, None]
    y[-fo:] *= np.linspace(1.0, 0.0, fo)[:, None]
    return y * 10 ** (SPEC['peak_dbfs'] / 20) / np.max(np.abs(y))


def active_rms(y):
    m = np.abs(y).max(1)
    on = m > m.max() * 10 ** (-30 / 20)
    return float(np.sqrt(np.mean(y[on] ** 2)))


rate, ch = SPEC['rate'], SPEC['channels']
only = set(sys.argv[1:])
