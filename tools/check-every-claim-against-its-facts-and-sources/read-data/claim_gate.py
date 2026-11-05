"""The claim check: every claim of a narrated shot, spoken or on screen, must hold against the person's world rows and
their sources. Pure apart from reading the files a request names; do-work/check_claims.py is its command.

A claim fails when:
  - a spoken sentence or on-screen text has no claims entry, or an entry matches nothing (coverage);
  - it is about the subject (rules `subject_words`) but cites no world fact said by someone other than the narrator
    (rules `support_said_by_not`);
  - a world fact about one of its topics is neither cited nor considered with a reason (so a fact like "she takes
    1,020 mg a day" cannot be ignored by a line about the same nutrient);
  - a quoted source wording is not in the source text, or a transcript quote is not at its second;
  - it is stronger than its sources on a strength scale (rules `strength`: "at most" against "up to");
  - a number in it is not derived from a cited fact or source, or sits outside its qualifier ("about", "nearly");
  - a bound in it ("at most ninety-nine milligrams") is broken by a number in a world fact on its topics;
  - a comparison it makes without saying the numbers ("less protein than one tub") does not hold on cited numbers;
  - it counts a number in a different container from its source ("the capsule is 1,020 mg" against "1,020 mg, one
    serving a day"; rules `quantity_units`);
  - a thing it says is visible cites no saved frame with what is observed in it and where the viewer sees it;
  - it uses a private world fact; a past, planned or questioned fact without saying so; a believed fact (too weak to
    state plainly: cut or rewrite it); someone's own claim (fact_kind claim) that is not recorded as their statement
    (world fact `source` and `source_at_s`); or a fact that conflicts with another it has not weighed;
  - it carries hedge or attribution wording (the request's `hedge_phrases`, the person's no-hedge check row). A claim
    a person makes on their own footage is stated plainly; the record says whose it is. Nothing is fixed by a hedge.

Ported one to one from a film repository's narrator/tools/fact_gate.py: its folders (shots and claims, the gate's
sources, the frames, the world) are the Config's, its rules are the person's settings, the subject's and narrator's
names are settings words, and the hedge phrases come in the request instead of being read from a file.
"""
import ast
import json
import os
import re

import world_rows

UNITS = {w: i for i, w in enumerate('zero one two three four five six seven eight nine ten eleven twelve thirteen '
                                    'fourteen fifteen sixteen seventeen eighteen nineteen'.split())}
TENS = {w: 10 * i for i, w in enumerate('_ _ twenty thirty forty fifty sixty seventy eighty ninety'.split()) if w != '_'}
SCALES = {'hundred': 100, 'thousand': 1000, 'million': 1000000}
UNIT_WORDS = {'milligrams': 'mg', 'milligram': 'mg', 'mg': 'mg', 'grams': 'g', 'gram': 'g', 'g': 'g',
              'calories': 'kcal', 'kcal': 'kcal', 'pounds': 'lb', 'lb': 'lb', 'kilos': 'kg', 'kg': 'kg', 'seconds': 's'}


def load(path):
    with open(path) as f:
        return json.load(f)


def hedges_in(words, phrases):
    """The hedge or attribution phrases (the person's no-hedge check row, shared with the copy check) in `words`."""
    return [p for p in phrases if re.search(rf'(?<!\w){re.escape(p)}(?!\w)', words, re.I)]


class Config:
    """Where one run reads from, and the person's settings.

    lane_dir     shots/<id>.json, claims/<id>.json and the voice scripts the shots name (relative to it)
    sources      the sources file ({"sources": {id: {text, ...}}}); a source's `text` is relative to its folder
    frames_root  the folder a claim's `frame` is relative to
    world_dir    the person's world rows (world_rows.World)
    hedge_phrases the phrases no claim may carry
    settings     {rules, subject_name, narrator_name, hedge_row}: rules as README.md describes
    path_map     optional {prefix: replacement} for source, transcript and frame paths written on another computer
    """

    def __init__(self, lane_dir, sources, frames_root, world_dir, hedge_phrases, settings, path_map=None):
        self.lane_dir, self.sources_file, self.frames_root, self.world_dir = lane_dir, sources, frames_root, world_dir
        self.hedge_phrases, self.path_map = list(hedge_phrases), dict(path_map or {})
        self.rules = settings['rules']
        self.subject_name = settings.get('subject_name', 'the subject')
        self.narrator_name = settings.get('narrator_name', 'the narrator')
        self.hedge_row = settings.get('hedge_row', 'check row no-hedge-or-attribution')

    def path(self, p, folder):
        return world_rows.resolve(p, folder, self.path_map)


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
    def __init__(self, config, world=None):
        self.config = config
        self.rules = config.rules
        self.gate_dir = os.path.dirname(os.path.abspath(config.sources_file))
        self.sources = load(config.sources_file)['sources']
        self.world = world or world_rows.World(config.world_dir)
        self.source_text = {}

    # ------------------------------------------------------------ support
    def text_of_source(self, sid):
        if sid not in self.source_text:
            with open(self.config.path(self.sources[sid]['text'], self.gate_dir)) as f:
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
                problem = world_rows.quote_problem({'said': src['quote'], 'source': src['transcript'],
                                                    'source_at_s': src['at_s']}, {}, self.config.world_dir, self.config.path_map)
                if problem:
                    fail(f'transcript quote "{src["quote"]}": {problem}')
                texts[f'transcript {os.path.basename(src["transcript"])} @ {src["at_s"]}'] = src['quote']
                said_by_ok = True
                continue
            if 'frame' in src:
                path = self.config.path(src['frame'], self.config.frames_root)
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
            for phrase in hedges_in(words, self.config.hedge_phrases):
                fail(f'carries the hedge or attribution "{phrase}" ({self.config.hedge_row}): state it '
                     f'plainly, or cut the line if it is too weak to state plainly')
        about_subject = any(t in self.rules['subject_words'] for t in toks)
        nums, ntoks = numbers_in(words)
        if kind == 'label':
            if words not in self.rules.get('labels', []):
                fail('is marked label but is not in rules.json labels')
            return
        if kind == 'no-claim':
            first = toks[0] if toks else ''
            if not (words.strip().endswith('?') or '?' in words or first in self.rules['no_claim']['imperative_verbs']):
                fail('is marked no-claim but is not a question or a request to the viewer')
            if nums and any(n[1] not in [x['spoken'] for x in entry.get('numbers', [])] for n in nums):
                fail('a no-claim sentence carries a number')
            return
        if kind not in ('claim', 'quote'):
            fail(f'kind must be claim, quote, label or no-claim, not {kind}')
            return

        texts, said_by_ok = self.support(entry, fail)
        if not texts:
            fail('cites no world fact and no source')
        if about_subject and not said_by_ok:
            fail(f'is about {self.config.subject_name} but cites no world fact or transcript said by someone other than '
                 f'{self.config.narrator_name}')
        if kind == 'quote':
            unfill = lambda t: ' '.join(w for w in flat(t).split() if w not in self.rules['fillers'])
            target = unfill(words)
            if not any(target in unfill(t) for t in texts.values()):
                fail('is shown as his words but no cited fact or transcript holds these words')
            return

        # every world fact on the topics is cited or considered
        topics = self.topics(entry, words)
        cited = set(entry.get('facts', [])) | set(entry.get('considered', {}))
        for c in self.rules['compounds']:
            if has_phrase(tokens(words), ' '.join(tokens(c['phrase']))) and c['entity'] not in topics:
                notes.append(f'{where}: names "{c["phrase"]}" ({c["entity"]}) as a reference, not a topic; '
                             f'declare it in `topics` if the line says something about it')
        for fid, fact in self.world.facts.items():
            shared = self.on_topic(fact, topics)
            if shared and fid not in cited and not set(fact['said_by']) & set(self.rules['support_said_by_not']):
                fail(f'world fact {fid} is on topic {sorted(shared)} and is neither cited nor considered: "{fact["said"]}"')
        self.check_fact_status(entry, words, fail)
        for fid, why in entry.get('considered', {}).items():
            if fid not in self.world.facts:
                fail(f'considers world fact {fid}, which does not exist')
            elif not why.strip():
                fail(f'considers {fid} without a reason')

        # strength: a word at bind_from_level or above is bound to the one support that says it as strongly
        bound = entry.get('strength', {})
        for scale, (lv, hits) in strength(words, self.rules['strength']).items():
            for phrase, level in hits:
                if level < self.rules['bind_from_level']:
                    continue
                key = bound.get(phrase)
                if not key:
                    fail(f'says "{phrase}" ({scale} level {level}) without naming, in `strength`, the cited support '
                         f'that says it as strongly')
                    continue
                if key.startswith('wording:'):
                    notes.append(f'{where}: "{phrase}" is wording, not a claim on the {scale} scale:{key[8:]}')
                    continue
                said = [t for k, t in texts.items() if k == key or k.startswith(key + ' #')]
                if not said:
                    fail(f'binds "{phrase}" to {key}, which this line does not cite')
                    continue
                theirs = max(strength(t, self.rules['strength'])[scale][0] for t in said)
                if theirs < level:
                    words_there = [p for t in said for p, _ in strength(t, self.rules['strength'])[scale][1]]
                    fail(f'is stronger than its source on {scale}: says "{phrase}" (level {level}), {key} says '
                         f'{words_there or "nothing on that scale"}: "{" | ".join(said)}"')
        for phrase in bound:
            if not any(phrase == p for _, hs in strength(words, self.rules['strength']).values() for p, _ in hs):
                fail(f'`strength` binds "{phrase}", which the line does not say')

        # numbers
        declared = {flat(n['spoken']): n for n in entry.get('numbers', [])}
        support_numbers = {k: [n[0] for n in numbers_in(t)[0]] for k, t in texts.items()}
        quals = {q: v for q, v in self.rules['qualifiers'].items() if q != '_about'}
        for value_said, phrase, start, end in nums:
            spec = declared.get(phrase)
            if not spec:
                fail(f'says the number "{phrase}" with no numbers entry')
                continue
            if spec.get('role') in ('wording', 'given'):
                if not spec.get('why'):
                    fail(f'number "{phrase}" is marked {spec["role"]} without a why')
                notes.append(f'{where}: "{phrase}" is {spec["role"]}: {spec.get("why", "")}')
                continue
            value = self.number_value(spec, texts, support_numbers, fail)
            if value is None:
                continue
            q = qualifier_before(ntoks, start, quals) or qualifier_after(ntoks, end, quals)
            if not within(value_said, value, quals[q]):
                fail(f'says "{(q + " " + phrase).strip()}" ({value_said:g}) but the sources give {value:.4g}')
            else:
                notes.append(f'{where}: "{(q + " " + phrase).strip()}" = {value_said:g}, sources give {value:.4g}')
            self.check_quantity_unit(spec, entry, ntoks, start, end, nums, phrase, fail)
            unit = unit_after(ntoks, end)
            if quals[q].get('bound') and unit:
                self.check_bound(value_said, quals[q]['side'], unit, topics, fail)
        for phrase in declared:
            if phrase not in [n[1] for n in nums]:
                fail(f'numbers entry "{phrase}" is not said in the line')

        # comparisons the line makes without saying the numbers ("less protein than one tub")
        for cmp in entry.get('compare', []):
            left = self.number_value({'expr': cmp['left'], 'inputs': cmp['inputs'], 'spoken': cmp['says']}, texts, support_numbers, fail)
            right = self.number_value({'expr': cmp['right'], 'inputs': cmp['inputs'], 'spoken': cmp['says']}, texts, support_numbers, fail)
            if left is None or right is None:
                continue
            holds = {'<': left < right, '<=': left <= right, '>': left > right, '>=': left >= right}[cmp['op']]
            line = f'"{cmp["says"]}": {cmp["left"]} = {left:.4g} {cmp["op"]} {cmp["right"]} = {right:.4g}'
            if holds:
                notes.append(f'{where}: {line}')
            else:
                fail(f'comparison does not hold, {line}')

    def unit_classes(self, toks, start, end, nums, past_one=False):
        """Quantity units (capsule, serving, tub...) attached to the number at toks[start:end]: up to 8 words before
        it and 14 after it, never past a neighbouring number. In a fact or source (past_one) a neighbouring "one"
        does not stop it: "1,020 mg, one serving a day". In a line it does: "fifteen pounds ... than one tub".
        A clause break (rules.json unit_clause_breaks: "than", "which", ...) stops it on both sides."""
        cls = {w: c for c, words in self.rules['quantity_units'].items() if c != '_about' for w in words}
        for group in self.rules['same_quantity_unit']:
            cls.update({w: group['units'][0] for w, c in list(cls.items()) if c in group['units']})
        lo = max([e for v, _, s, e in nums if e <= start and not (past_one and v == 1)] + [start - 8, 0])
        hi = min([s for v, _, s, _ in nums if s >= end and not (past_one and v == 1)] + [end + 14, len(toks)])
        breaks = set(self.rules['unit_clause_breaks'])
        lo = max([i + 1 for i in range(lo, start) if toks[i] in breaks] + [lo])
        hi = min([i for i in range(end, hi) if toks[i] in breaks] + [hi])
        return {cls[t] for t in toks[lo:start] + toks[end:hi] if t in cls}

    def ref_units(self, ref, value, entry):
        """Quantity units the cited fact, or the cited source wording, attaches to `value`."""
        if 'fact' in ref:
            fact = self.world.facts.get(ref['fact'], {})
            texts = [fact.get('statement', ''), fact.get('said', '')]
        elif 'source' in ref:
            texts = [q['quote'] for q in entry.get('sources', []) if q.get('source') == ref['source']]
        else:
            return set()
        found = set()
        for text in texts:
            nums, toks = numbers_in(text)
            for v, _, s, e in nums:
                if abs(v - value) < 1e-9:
                    found |= self.unit_classes(toks, s, e, nums, past_one=True)
        return found

    def check_quantity_unit(self, spec, entry, toks, start, end, nums, phrase, fail):
        """The container a line counts a number in must be the one its fact or source counts it in."""
        said = self.unit_classes(toks, start, end, nums)
        if not said:
            return
        refs = ([spec] if 'value' in spec else []) + list(spec.get('inputs', {}).values())
        source_units = set()
        for r in refs:
            source_units |= self.ref_units(r, float(r['value']), entry)
        for unit in sorted(said - source_units):
            fail(f'counts "{phrase}" per {unit}, but its sources attach that number to '
                 f'{" or ".join(sorted(source_units)) or "no container"}')

    def number_value(self, spec, texts, support_numbers, fail):
        def from_support(v, ref):
            if 'given' in ref:
                return bool(ref['given'].strip()) or fail(f'number {v:g} is given without a reason') or False
            key = f'fact {ref["fact"]}' if 'fact' in ref else f'source {ref["source"]}' if 'source' in ref else 'transcript'
            keys = [k for k in support_numbers if k == key or k.startswith(key + ' #') or (key == 'transcript' and k.startswith('transcript'))]
            if not keys:
                fail(f'number {v:g} cites {key}, which this line does not cite')
                return False
            if not any(abs(v - n) < 1e-9 for k in keys for n in support_numbers[k]):
                fail(f'number {v:g} is not in {key} ("{" | ".join(texts[k] for k in keys)}")')
                return False
            return True

        if 'expr' in spec:
            names = {}
            for name, ref in spec.get('inputs', {}).items():
                if from_support(float(ref['value']), ref):
                    names[name] = ref['value']
            try:
                return safe_eval(spec['expr'], names)
            except (ValueError, SyntaxError, KeyError) as e:
                fail(f'number expression {spec["expr"]}: {e}')
                return None
        if 'value' in spec:
            return float(spec['value']) if from_support(float(spec['value']), spec) else None
        fail(f'number "{spec["spoken"]}" has no value, expr or role')
        return None

    def check_bound(self, value_said, side, unit, topics, fail):
        for fid, fact in self.world.facts.items():
            if not self.on_topic(fact, topics) or fact.get('tense') == 'past' or set(fact['said_by']) & set(self.rules['support_said_by_not']):
                continue
            nums, toks = numbers_in(fact['said'])
            for v, phrase, start, end in nums:
                if unit_after(toks, end) != unit and not re.search(rf'{re.escape(phrase)}\s*{unit}\b', fact['said'].lower()):
                    continue
                broken = {'below': v >= value_said, 'below_or_equal': v > value_said,
                          'above': v <= value_said, 'above_or_equal': v < value_said}[side]
                if broken:
                    fail(f'bound {side.replace("_", " ")} {value_said:g} {unit} is contradicted by world fact {fid}: '
                         f'"{fact["said"]}"')

    # ------------------------------------------------------------ one shot
    def check_shot(self, sid):
        LANE = self.config.lane_dir
        shot = load(os.path.join(LANE, 'shots', f'{sid}.json'))
        claims_path = os.path.join(LANE, 'claims', f'{sid}.json')
        fails, notes = [], []
        if not os.path.exists(claims_path):
            return [f'{sid}: no claims file {claims_path}'], notes
        claims = load(claims_path)
        with open(os.path.join(LANE, shot['voice']['script'])) as f:
            script = spoken(f.read())
        joined = ' '.join(e['words'] for e in claims['voice'])
        if flat(joined) != flat(script):
            fails.append(f'{sid}: voice claims do not cover the script exactly.\n   script: {script}\n   claims: {joined}')
        for k, e in enumerate(claims['voice']):
            self.check_entry(e, e['words'], f'{sid} voice {k + 1}', fails, notes)
        shown = screen_texts(shot)
        entries = {e['text']: e for e in claims['screen']}
        for where, text in shown:
            e = entries.get(text)
            if not e:
                fails.append(f'{sid} screen {where}: "{one_line(text)}" has no claims entry')
                continue
            self.check_entry(e, text, f'{sid} screen {where}', fails, notes)
        for text in set(entries) - {t for _, t in shown}:
            fails.append(f'{sid}: screen claims entry "{one_line(text)}" is not on screen')
        return fails, notes


def within(said, value, rule):
    side = rule.get('side')
    if side in ('below', 'below_or_equal') and said < value - 1e-9:
        return False
    if side in ('above', 'above_or_equal') and said > value + 1e-9:
        return False
    if 'rel' in rule:
        if abs(said - value) <= rule['rel'] * abs(value) + 1e-9:
            return True
        return bool(rule.get('or_rounds_to_integer') and said == round(said) and round(value) == said)
    return True


def screen_texts(shot):
    out = []
    for e in shot['events']:
        where = f'{e["type"]} {e.get("id", "")}'.strip()
        if e['type'] == 'figure':
            text = f'{e["label"]}\n{e["fmt"].format(e["value_to"])}{e.get("suffix", "")}'
            out.append((where, text + (f'\n{e["sub"]}' if e.get('sub') else '')))
            continue
        for key in ('text', 'caption'):
            if e.get(key):
                out.append((where, e[key]))
    return out


def one_line(s):
    return ' / '.join(s.split('\n'))


def check(config, sid, quiet=False, world=None, world_check=None, label='fact gate'):
    """(ok, report lines, fails, notes). The world's own check must pass first; `world_check` is a (ok, lines) already
    made for this world, so a run over many shots checks the world once."""
    world = world or world_rows.World(config.world_dir)
    world_ok, world_lines = world_check or world_rows.verify(world, config.path_map)
    if not world_ok:
        return False, ['world graph verify failed:'] + [l for l in world_lines if l.startswith('PROBLEM')], [], []
    fails, notes = Gate(config, world).check_shot(sid)
    lines = [f'FAIL {f}' for f in fails] + ([] if quiet else [f'ok   {n}' for n in notes])
    lines.append(f'{label} {sid}: ' + ('PASS' if not fails else f'{len(fails)} failures'))
    return not fails, lines, fails, notes
