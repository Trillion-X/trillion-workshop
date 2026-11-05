"""The world rows a claim check reads: entities, facts and relations, and their own check.

A person's world is DATA in the input shapes of their lists (`lists.json`: the lists world-kinds, world-entities and
world-facts; `rows/<list>.json`: each list's rows; `relations.json`: relations whose `said` starts with
`fact:<world-facts row id>`). Kinds of things, kinds of facts and relation roles are rows of world-kinds, never names in
this file. The folder is the request's `world_dir`; a relative `source` in a fact is read from that folder.

Ported one to one from a film repository's library/world/world.py (World, quote_problem, verify); the folder is an
argument instead of where the file sat, and verify returns its lines instead of printing them.
"""
import json
import os
import re

ROW_PREFIX = 'record:'


class World:
    def __init__(self, folder):
        self.folder = folder

        def read(name):
            with open(os.path.join(folder, name)) as f:
                return json.load(f)
        self.lists = {item['list']['id']: item['list'] for item in read('lists.json')['lists']}
        self.rows = {lid: {r['id']: r['values'] for r in read(f'rows/{lid}.json')['rows']} for lid in self.lists}
        self.relations = read('relations.json')['relations']
        self.kinds = self.rows['world-kinds']
        self.entities = self.rows['world-entities']
        self.facts = self.rows['world-facts']
        self.type_to_list = {spec['row_type']: lid for lid, spec in self.lists.items()}

    def record(self, ref):
        """(list id, row id) for record:<row type>:<id>, or None for `me` and unknown refs."""
        if not ref.startswith(ROW_PREFIX):
            return None
        row_type, _, row_id = ref[len(ROW_PREFIX):].partition(':')
        lid = self.type_to_list.get(row_type)
        return (lid, row_id) if lid and row_id in self.rows[lid] else None

    def fact_of(self, relation):
        m = re.match(r'fact:(\S+)', relation.get('said', ''))
        return m.group(1) if m else None


NORM = re.compile(r"[^a-z0-9.%]")


def norm(s):
    return NORM.sub('', s.lower().replace("'", '')).rstrip('.')


FITS = {
    'text': lambda x: isinstance(x, str), 'long-text': lambda x: isinstance(x, str),
    'number': lambda x: isinstance(x, (int, float)) and not isinstance(x, bool),
    'tags': lambda x: isinstance(x, list) and all(isinstance(i, str) for i in x),
    'link': lambda x: isinstance(x, list) and all(isinstance(i, str) for i in x),
    'choice': lambda x: isinstance(x, str),
}
TEXT_CHARS = 20000  # the list engine's text limit


def resolve(path, folder, path_map=None):
    """A source path as this run reads it: `path_map` prefixes rewritten first, then a relative path is read from `folder`."""
    for old, new in (path_map or {}).items():
        if path.startswith(old):
            path = new + path[len(old):]
            break
    return path if os.path.isabs(path) else os.path.join(folder, path)


def quote_problem(v, words_cache, folder, path_map=None):
    """None when the fact's words are at its source (a transcript word list at `source_at_s`, or a file line at
    `source_line`), else what is wrong."""
    src = resolve(v['source'], folder, path_map)
    if not os.path.exists(src):
        return f'source missing: {src}'
    if 'said' not in v:  # a fact read off a saved frame has no words to match, only the frame file
        return None
    said = v['said']
    if 'source_at_s' in v:
        if src not in words_cache:
            with open(src) as f:
                words_cache[src] = [w for w in json.load(f)['words'] if w.get('type', 'word') == 'word']  # untyped word lists hold only words
        words = words_cache[src]
        want = [norm(x) for x in said.split() if norm(x)]
        start = next((i for i, w in enumerate(words) if abs(w['start'] - v['source_at_s']) < 0.006), None)
        if start is None:
            return f'no word starts at {v["source_at_s"]} s'
        got = [norm(w['text']) for w in words[start:start + len(want)]]
        return None if got == want else f'words at {v["source_at_s"]} s are "{" ".join(w["text"] for w in words[start:start + len(want)])}"'
    with open(src) as f:
        lines = f.read().split('\n')
    line = v.get('source_line', 0)
    text = ' '.join(lines[line - 1].replace('\\', '').split()) if 0 < line <= len(lines) else ''
    return None if ' '.join(said.split()) in text else f'line {line} does not hold the words'


def verify(world, path_map=None):
    """(ok, lines): shapes, links, roles and every quote against its source. The lines are the counts, one
    `PROBLEM ...` line per problem and a last `verify: ...` line."""
    problems, words_cache = [], {}
    for lid, spec in world.lists.items():
        fields = {f['id']: f for f in spec['fields']}
        for rid, values in world.rows[lid].items():
            if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,199}', rid):
                problems.append(f'{lid}/{rid}: row id shape')
            for key, value in values.items():
                field = fields.get(key)
                if not field:
                    problems.append(f'{lid}/{rid}: unknown field {key}')
                    continue
                if not FITS[field['kind']](value):
                    problems.append(f'{lid}/{rid}: {key} is not a {field["kind"]} value')
                if field['kind'] == 'choice' and value not in field['choices']:
                    problems.append(f'{lid}/{rid}: {key}={value} is not a choice')
                if field['kind'] == 'link':
                    problems += [f'{lid}/{rid}: {key} links to missing {t}' for t in value if t not in world.rows[field['links_to']]]
                if len(json.dumps(value)) > TEXT_CHARS:
                    problems.append(f'{lid}/{rid}: {key} too long')
    for eid, v in world.entities.items():
        if world.kinds.get(v['kind'][0], {}).get('applies_to') != 'entity':
            problems.append(f'entity {eid}: kind {v["kind"][0]} is not an entity kind')
    for fid, v in world.facts.items():
        if world.kinds.get(v['fact_kind'][0], {}).get('applies_to') != 'fact':
            problems.append(f'fact {fid}: kind {v["fact_kind"][0]} is not a fact kind')
        bad = quote_problem(v, words_cache, world.folder, path_map)
        if bad:
            problems.append(f'fact {fid}: {bad}')
    roles = {v['label'] for v in world.kinds.values() if v['applies_to'] == 'relation'}
    for i, r in enumerate(world.relations):
        for end in ('subject', 'object'):
            if r[end] != 'me' and not world.record(r[end]):
                problems.append(f'relation {i}: {end} {r[end]} is not a world row')
        if r['role'] not in roles:
            problems.append(f'relation {i}: role "{r["role"]}" is not a world-kinds relation row')
        fid = world.fact_of(r)
        if fid not in world.facts:
            problems.append(f'relation {i}: said must start with fact:<a world-facts id>')
        elif not r['said'].endswith(world.facts[fid]['said']):
            problems.append(f'relation {i}: said does not carry fact {fid} words')
    cited = {e for v in world.facts.values() for e in v['about'] + v.get('episode', [])}
    problems += [f'entity {eid}: no fact is about it' for eid in world.entities if eid not in cited]
    counts = {
        'entities': len(world.entities), 'facts': len(world.facts), 'relations': len(world.relations),
        'entity kinds': sum(v['applies_to'] == 'entity' for v in world.kinds.values()),
        'fact kinds': sum(v['applies_to'] == 'fact' for v in world.kinds.values()),
        'relation roles': len(roles),
        'quotes checked against transcripts': sum('source_at_s' in v for v in world.facts.values()),
        'quotes checked against file lines': sum('source_line' in v for v in world.facts.values()),
    }
    lines = [f'{value:4d}  {key}' for key, value in counts.items()] + [f'PROBLEM {p}' for p in problems]
    lines.append('verify: ok' if not problems else f'verify: {len(problems)} problems')
    return not problems, lines
