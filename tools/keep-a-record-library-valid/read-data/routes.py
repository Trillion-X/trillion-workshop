"""Which questions a piece is asked: its header tags, the route grammar and the selection of a small set from a question bank.

A question bank record is { id, stage, question, verify_by, source, routes?, same_as? }. A profile is { id, groups: [group id] }; a group
is { id, questions: [question id], tools }. The investigation settings in the schema name the pools these come from.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

from library import Store


def parse_header(header_file: Path, heading: str) -> dict[str, str]:
    """The `key: value` lines of the fenced block under the heading (any level, containing these words) of a markdown file."""
    if not header_file.is_file():
        return {}
    text = header_file.read_text(encoding='utf-8')
    m = re.search(r'^#+[^\n]*' + re.escape(heading) + r'[^\n]*\n+```[^\n]*\n(.*?)\n```', text, re.M | re.S)
    if not m:
        return {}
    out: dict[str, str] = {}
    key = None
    for line in m.group(1).splitlines():
        km = re.match(r'^([a-z][a-z ]*?):\s*(.*)$', line)
        if km and not line.startswith(' '):
            key = km.group(1).strip()
            out[key] = km.group(2).strip()
        elif key and line.strip():
            out[key] += ' ' + line.strip()
    return out


def header_tags(header: dict[str, str], cfg: dict) -> set[str]:
    """The tags a header's tag fields hold (words in parentheses are comments), plus the tags those imply (`kind:*` implies for any `kind:` tag)."""
    tags: set[str] = set()
    for field in cfg['piece_header']['tag_fields']:
        value = re.sub(r'\([^)]*\)', ' ', header.get(field, ''))
        tags |= {t for t in re.split(r'[\s,|]+', value) if re.fullmatch(r'[a-z0-9:+-]+', t)}
    for tag, implied in cfg['piece_header']['implied_tags'].items():
        if tag.endswith(':*'):
            if any(t.startswith(tag[:-1]) for t in tags):
                tags |= set(implied)
        elif tag in tags:
            tags |= set(implied)
    return tags


def route_applies(expr: str, tags: set[str]) -> bool:
    """Route grammar: `all`; comma = any; `+` = all; `(not x)` excludes x."""
    expr = expr.strip()
    excluded = re.findall(r'\(not ([^)]+)\)', expr)
    base = re.sub(r'\(not [^)]+\)', '', expr).strip()
    if any(x.strip() in tags for x in excluded):
        return False
    if not base or base == 'all':
        return True
    return any(all(p.strip() in tags for p in term.split('+')) for term in base.split(','))


def route_tags(expr: str) -> list[str]:
    """Every tag a route names."""
    return re.findall(r'[a-z][a-z:]*', re.sub(r'\bnot\b', '', expr))


def target_kind(piece: Path, store: Store) -> str:
    """The first target kind whose folder holds the piece, else the default kind."""
    cfg = store.investigation['target_kinds']
    for rule in cfg['rules']:
        try:
            piece.resolve().relative_to((store.root / rule['under']).resolve())
            return rule['kind']
        except ValueError:
            continue
    return cfg['default']


def select_questions(store: Store, profile_id: str, tags: set[str], kind: str, limit: int) -> dict:
    profiles = store.by_id(store.pool_of('profiles'))
    if profile_id not in profiles:
        raise ValueError(f'Unknown run profile: {profile_id}. Profiles: {", ".join(profiles)}')
    if not 1 <= limit <= 99:
        raise ValueError('limit must be between 1 and 99')
    groups = store.by_id(store.pool_of('groups'))
    bank = store.by_id(store.pool_of('questions'))
    skip_stages = set(store.investigation['selection']['skip_stages_by_target_kind'].get(kind, []))
    skipped: dict[str, str] = {}
    lanes: list[list[tuple[str, dict]]] = []
    seen: set[str] = set()
    for gid in profiles[profile_id]['groups']:
        lane = []
        for qid in groups[gid]['questions']:
            if qid in seen:
                continue
            seen.add(qid)
            q = bank[qid]
            if q.get('same_as'):
                skipped[qid] = f'answered by {q["same_as"]} (same_as)'
            elif q['stage'] in skip_stages:
                skipped[qid] = f'stage {q["stage"]} is not asked of a {kind} target'
            elif not route_applies(q.get('routes', 'all'), tags):
                skipped[qid] = f'routes "{q["routes"]}" false for this header'
            else:
                lane.append((gid, q))
        lanes.append(lane)
    candidates = [qid for lane in lanes for _, q in lane for qid in [q['id']]]
    chosen: list[tuple[str, dict]] = []
    depth = 0
    while len(chosen) < limit and any(depth < len(l) for l in lanes):
        for lane in lanes:
            if depth < len(lane) and len(chosen) < limit:
                chosen.append(lane[depth])
        depth += 1
    chosen_ids = {q['id'] for _, q in chosen}
    for qid in candidates:
        if qid not in chosen_ids:
            skipped[qid] = f'over the limit of {limit}'
    return {'profile': profiles[profile_id], 'chosen': chosen, 'candidates': candidates, 'skipped': skipped, 'groups': groups}


def build_nodes(store: Store, chosen: list[tuple[str, dict]], groups: dict) -> list[dict]:
    """The first node is the scope node the schema describes; every question depends on it, and a question of a closing stage also on every other chosen one."""
    closing = set(store.investigation['prerequisites']['closing_stages'])
    base = [q['id'] for _, q in chosen if q['stage'] not in closing]
    scope = {**store.investigation['scope_node'], 'depends_on': [], 'status': 'open'}
    nodes = [scope]
    for gid, q in chosen:
        deps = [scope['id']] + (base if q['stage'] in closing else [])
        nodes.append({'id': q['id'], 'question': q['question'], 'verify_by': q['verify_by'], 'stage': q['stage'], 'group': gid,
                      'tools': groups[gid]['tools'], 'source': q['source'], 'depends_on': deps, 'status': 'open'})
    return nodes


def search_library(store: Store, words: list[str], limit: int = 10) -> list[dict]:
    """Rank lexical matches; an empty list is not evidence that no useful finding exists."""
    library = store.load_findings()

    def tokens(value: str) -> set[str]:
        # Split punctuation (including hyphens) and require whole alphanumeric tokens.
        return set(re.findall(r'[a-z0-9]+', value.casefold()))

    def forms(token: str) -> frozenset[str]:
        # Let simple singular/plural pairs meet without prefix-matching other words.
        variants = {token}
        if len(token) > 4 and token.endswith('s') and not token.endswith(('ss', 'us', 'is')):
            variants.add(token[:-1])
        elif len(token) > 4 and not token.endswith('s'):
            variants.add(token + 's')
        return frozenset(variants)

    # Keep meaningful short alphanumeric terms (e.g. UI, 3D, SFX) case-insensitively;
    # one-character tokens add noise. Common terms are naturally downweighted by IDF.
    query_terms = {forms(token) for word in words for token in tokens(word) if len(token) >= 2}
    if not query_terms or not library:
        return []

    documents = []
    document_frequency = {term: 0 for term in query_terms}
    for finding in library:
        text = json.dumps(finding, ensure_ascii=False)
        document_terms = tokens(text)
        title_terms = tokens(finding.get('title', ''))
        documents.append((finding, document_terms, title_terms))
        for term in query_terms:
            if term & document_terms:
                document_frequency[term] += 1

    # Rare query terms carry more weight by corpus document frequency; a title match
    # adds a modest generic boost. This is IDF-weighted lexical ranking, not semantic search.
    count = len(documents)
    scored = []
    for finding, document_terms, title_terms in documents:
        score = 0.0
        for term in query_terms:
            if term & document_terms:
                frequency = document_frequency[term]
                inverse_frequency = math.log(1 + (count - frequency + 0.5) / (frequency + 0.5))
                score += inverse_frequency * (1.5 if term & title_terms else 1)
        if score:
            scored.append((score, {'id': finding['id'], 'title': finding['title']}))
    # Python's stable sort keeps library order for equal scores.
    return [hit for _, hit in sorted(scored, key=lambda item: -item[0])][:limit]
