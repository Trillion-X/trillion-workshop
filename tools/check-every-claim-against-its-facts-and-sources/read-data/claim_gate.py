    the copy-rules row no-hedge-or-attribution in consolidation/data/copy-rules.json). A claim he makes on his own footage is stated plainly; the record says
    whose it is. Nothing is fixed by adding a hedge.
"""
import ast
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NARRATOR = os.path.normpath(os.path.join(HERE, '..'))
GATE = os.path.join(NARRATOR, 'fact-gate')
LANE = os.environ.get('FACT_GATE_LANE_DIR') or NARRATOR      # where this run's shots/, claims/ and voice scripts live (a lane folder keeps its own); rules and sources stay shared in GATE
COPY_RULES = os.path.normpath(os.path.join(NARRATOR, '..', '..', '..', 'consolidation', 'data', 'copy-rules.json'))
HEDGE_ROW = 'no-hedge-or-attribution'
WORLD_DIR = os.path.normpath(os.path.join(NARRATOR, '..', '..', '..', 'library', 'world'))
sys.path.insert(0, WORLD_DIR)
sys.dont_write_bytecode = True  # keep library/world free of __pycache__
import world as worldgraph  # noqa: E402  (library/world/world.py, the world graph owner)

UNITS = {w: i for i, w in enumerate('zero one two three four five six seven eight nine ten eleven twelve thirteen '
                                    'fourteen fifteen sixteen seventeen eighteen nineteen'.split())}
TENS = {w: 10 * i for i, w in enumerate('_ _ twenty thirty forty fifty sixty seventy eighty ninety'.split()) if w != '_'}
SCALES = {'hundred': 100, 'thousand': 1000, 'million': 1000000}
UNIT_WORDS = {'milligrams': 'mg', 'milligram': 'mg', 'mg': 'mg', 'grams': 'g', 'gram': 'g', 'g': 'g',
              'calories': 'kcal', 'kcal': 'kcal', 'pounds': 'lb', 'lb': 'lb', 'kilos': 'kg', 'kg': 'kg', 'seconds': 's'}


def load(path):
    with open(path) as f:
        return json.load(f)


def hedges_in(words):
    """The hedge or attribution phrases (the copy-rules row no-hedge-or-attribution, shared with the copy gate) in `words`."""
    phrases = next(row['words'] for row in load(COPY_RULES)['rules'] if row['id'] == HEDGE_ROW)
    return [p for p in phrases if re.search(rf'(?<!\w){re.escape(p)}(?!\w)', words, re.I)]


def spoken(script):
    """The words Kokoro says: [word](/ipa/) -> word, [pause n] removed."""
    s = re.sub(r'\[pause [\d.]+\]', ' ', script)
    s = re.sub(r'\[([^\]]+)\]\(/[^)]*/\)', r'\1', s)
    return ' '.join(s.split())


def tokens(text):
    return re.findall(r"\d+(?:,\d{3})*(?:\.\d+)?|[a-z]+(?:'[a-z]+)?", text.lower().replace('-', ' '))


def word_tokens(text):
    """Words with hyphenated compounds kept whole, so "potassium-only" is not the scope word "only"."""
    return re.findall(r"[a-z]+(?:['-][a-z]+)*", text.lower())


def flat(text):
    return ' '.join(tokens(text))


def has_phrase(toks, phrase):
    p = phrase.split()
    return [i for i in range(len(toks) - len(p) + 1) if toks[i:i + len(p)] == p]


def numbers_in(text):
    """[(value, phrase, start, end)] for digit and English-word numbers, on the token list of `text`."""
    toks, out, i = tokens(text), [], 0
    while i < len(toks):
        t = toks[i]
        if re.fullmatch(r'\d+(?:,\d{3})*(?:\.\d+)?', t):
            out.append((float(t.replace(',', '')), t, i, i + 1))
            i += 1
            continue
        if t in UNITS or t in TENS or t in SCALES:
            total, cur, j = 0, 0, i
            while j < len(toks):
                w = toks[j]
                if w in UNITS:
                    cur += UNITS[w]
                elif w in TENS:
                    cur += TENS[w]
                elif w == 'hundred':
                    cur = max(cur, 1) * 100
                elif w in SCALES:
                    total += max(cur, 1) * SCALES[w]
                    cur = 0
                elif w == 'and' and toks[j - 1] in SCALES and j + 1 < len(toks) and (toks[j + 1] in UNITS or toks[j + 1] in TENS):
                    pass
                else:
                    break
                j += 1
            value = float(total + cur)
            if toks[j:j + 3] == ['and', 'a', 'half']:
                value, j = value + 0.5, j + 3
            elif j + 1 < len(toks) and toks[j] == 'point' and toks[j + 1] in UNITS:
                digits = ''
                j += 1
                while j < len(toks) and toks[j] in UNITS and UNITS[toks[j]] < 10:
                    digits, j = digits + str(UNITS[toks[j]]), j + 1
                value = float(f'{int(value)}.{digits}')
            out.append((value, ' '.join(toks[i:j]), i, j))
            i = j
            continue
        i += 1
    return out, toks


def qualifier_before(toks, start, quals):
    for n in (2, 1):
        q = ' '.join(toks[max(0, start - n):start])
        if start - n >= 0 and q in quals:
            return q
    return ''


def qualifier_after(toks, end, quals):
    """A bound said after the number and its unit: "ninety-nine milligrams at most"."""
    start = end + (1 if end < len(toks) and toks[end] in UNIT_WORDS else 0)
    for n in (2, 1):
        q = ' '.join(toks[start:start + n])
        if q in quals and quals[q].get('bound'):
            return q
    return ''


def unit_after(toks, end):
    for t in toks[end:end + 2]:
        if t in UNIT_WORDS:
            return UNIT_WORDS[t]
    return None


def strength(text, scales):
    """{scale: (highest level, [(phrase, level)])} using longest phrases first; a matched span is not matched again."""
    toks = word_tokens(text)
    used = [False] * len(toks)
    result = {}
    for scale, levels in scales.items():
        phrases = sorted(((p, int(lv)) for lv, ps in levels.items() if lv != '_about' for p in ps),
                         key=lambda x: -len(x[0].split()))
        taken = list(used)
        best, hits = 0, []
        for p, lv in phrases:
            n = len(word_tokens(p))
            for i in has_phrase(toks, ' '.join(word_tokens(p))):
                if not any(taken[i:i + n]):
                    taken[i:i + n] = [True] * n
                    best, hits = max(best, lv), hits + [(p, lv)]
        result[scale] = (best, hits)
    return result


def safe_eval(expr, names):
    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.BinOp) and type(node.op) in (ast.Add, ast.Sub, ast.Mult, ast.Div):
            a, b = ev(node.left), ev(node.right)
            return {ast.Add: a + b, ast.Sub: a - b, ast.Mult: a * b, ast.Div: a / b if b else float('nan')}[type(node.op)]
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.Name) and node.id in names:
            return float(names[node.id])
        raise ValueError(f'expression part not allowed: {ast.dump(node)[:60]}')
    return ev(ast.parse(expr, mode='eval'))


class Gate:
    def __init__(self):
        self.rules = load(os.path.join(GATE, 'rules.json'))
        self.sources = load(os.path.join(GATE, 'sources.json'))['sources']
        self.world = worldgraph.World()
        self.source_text = {}

    # ------------------------------------------------------------ support
    def text_of_source(self, sid):
        if sid not in self.source_text:
            with open(os.path.join(GATE, self.sources[sid]['text'])) as f:
                self.source_text[sid] = ' '.join(f.read().split())
        return self.source_text[sid]

    def support(self, entry, fail):
        """Check every cited fact and quote; return the support texts (fact words and source wordings)."""
        texts, said_by_ok = {}, False
        for fid in entry.get('facts', []):
            fact = self.world.facts.get(fid)
            if not fact:
                fail(f'cites world fact {fid}, which does not exist')
                continue
            texts[f'fact {fid}'] = fact['said']
            said_by_ok |= not set(fact['said_by']) & set(self.rules['support_said_by_not'])
        for k, src in enumerate(entry.get('sources', [])):
            if 'transcript' in src:
                problem = worldgraph.quote_problem({'said': src['quote'], 'source': src['transcript'],
                                                    'source_at_s': src['at_s']}, {})
                if problem:
                    fail(f'transcript quote "{src["quote"]}": {problem}')
                texts[f'transcript {os.path.basename(src["transcript"])} @ {src["at_s"]}'] = src['quote']
                said_by_ok = True
                continue
            if 'frame' in src:
                path = os.path.join(NARRATOR, src['frame'])
                if not os.path.exists(path):
                    fail(f'frame {src["frame"]} does not exist')
                elif not src.get('observed', '').strip() or not src.get('shown', '').strip():
                    fail(f'frame {src["frame"]} needs `observed` (what is visible) and `shown` (where the viewer sees it)')
                texts[f'frame {src["frame"]}'] = src.get('observed', '')
                continue
            sid = src.get('source')
            if sid not in self.sources:
                fail(f'source {sid} is not in fact-gate/sources.json')
                continue
            if ' '.join(src['quote'].split()) not in self.text_of_source(sid):
                fail(f'source {sid} does not contain "{src["quote"]}"')
            texts[f'source {sid} #{k + 1}'] = src['quote']
        return texts, said_by_ok

    # ------------------------------------------------------------ one entry
    def topics(self, entry, words):
        """Entity ids the line is about: declared, plus object entities it names."""
        found = set(entry.get('topics', []))
        toks = tokens(words)
        inside = set()
        for c in self.rules['compounds']:
            ct = tokens(c['phrase'])
            for i in has_phrase(toks, ' '.join(ct)):
                inside |= set(range(i, i + len(ct)))
        for eid, v in self.world.entities.items():
            if v['kind'][0] not in self.rules['auto_topic_kinds']:
                continue
            for name in [v['name']] + v.get('aliases', []):
                nt = [t for t in tokens(name) if t != 'the']
                for form in (nt, nt[:-1] + [nt[-1] + 's'] if nt else nt):
                    if form and any(not set(range(i, i + len(form))) <= inside for i in has_phrase(toks, ' '.join(form))):
                        found.add(eid)
        return found - set(self.rules['accounting_skips'])

    def on_topic(self, fact, topics):
        """The topics a world fact shares with a line: a linked entity in `about`, or a `topics` tag that is the
        entity's own name, id or alias. Tags that merely co-occur ("pantry", "recipes") do not count."""
        tags = {flat(t) for t in fact.get('topics', [])}
        shared = (set(fact['about']) & topics) | {t for t in topics if flat(t.replace('-', ' ')) in tags}
        for eid in topics - shared:
            v = self.world.entities.get(eid, {})
            names = {flat(eid.replace('-', ' '))} | {flat(n) for n in [v.get('name', '')] + v.get('aliases', []) if n}
            names |= {' '.join(t for t in n.split() if t != 'the') for n in names}
            names |= {flat(t) for c in self.rules['compounds'] if c['entity'] == eid for t in c['tags']}
            if tags & names:
                shared.add(eid)
        return shared

    def fact_refs(self, entry):
        refs = set(entry.get('facts', []))
        for spec in entry.get('numbers', []) + entry.get('compare', []):
            refs |= {i['fact'] for i in spec.get('inputs', {}).values() if 'fact' in i}
            if 'fact' in spec:
                refs.add(spec['fact'])
        return refs

    def check_fact_status(self, entry, words, fail):
        """private facts never reach a public line; a past, planned or believed fact only supports a line that says so;
        a fact that conflicts with another is used only after the other is weighed; his on-camera claims are his."""
        toks = ' ' + flat(words) + ' '
        has = lambda key: any(f' {flat(m)} ' in toks for m in self.rules['tense_markers'][key])
        cited = set(entry.get('facts', [])) | set(entry.get('considered', {}))
        for fid in sorted(self.fact_refs(entry)):
            fact = self.world.facts.get(fid)
            if not fact:
                continue
            if fact.get('private') == 'yes':
                fail(f'uses world fact {fid}, which is private')
            tense = fact.get('tense')
            if tense == 'belief':
                fail(f'uses {fid}, a belief ("{fact["said"]}"): too weak to state plainly. Cut it or rewrite the line '
                     f'without it; do not add a hedge')
            elif tense in self.rules['tense_markers'] and not has(tense):
                fail(f'uses {fid} ({tense}, as of {fact.get("as_of", "?")}) but the line does not say it as {tense}: '
                     f'needs one of {self.rules["tense_markers"][tense]}')
            if fact['fact_kind'][0] in self.rules['claim_fact_kinds']:
                said_by = set(fact['said_by']) & set(self.rules['claim_said_by'])
                if not said_by or not fact.get('source') or fact.get('source_at_s') is None:
                    fail(f'uses {fid}, a claim ("{fact["said"]}") that is not recorded as his statement: the world '
                         f'fact needs `source` and `source_at_s` and a `said_by` in rules.json claim_said_by. Record '
                         f'it or cut the line; do not add an attribution')
            others = set(fact.get('conflicts_with', [])) | {o for o, v in self.world.facts.items() if fid in v.get('conflicts_with', [])}
            for other in sorted(others - cited):
                fail(f'uses {fid}, which conflicts with {other} ("{self.world.facts[other]["statement"]}"): cite or consider it')

    def check_entry(self, entry, words, where, fails, notes):
        def fail(msg):
            fails.append(f'{where}: "{one_line(words)}": {msg}')

        kind = entry.get('kind')
        toks = tokens(words)
        if kind != 'quote':
            for phrase in hedges_in(words):
                fail(f'carries the hedge or attribution "{phrase}" (copy-rules row no-hedge-or-attribution): state it '
                     f'plainly, or cut the line if it is too weak to state plainly')
