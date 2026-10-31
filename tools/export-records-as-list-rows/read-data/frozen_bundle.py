"""Freeze everything a root needs into one bundle that can be shared and checked by its content identity.

Given the refs a root directly needs and what each ref resolves to (records and files the caller read from the person's
account), walk the transitive closure of refs, freeze each part into the bundle (a file by its hash, a record's value
as data), run the two gates that decide whether the bundle may be published, and give back canonical bytes whose BLAKE3
is the bundle's identity. Same input, same bytes, same identity.

Invariants:
- Blind to the root: it is carried through verbatim and never read. The owner of the root's format lists the refs it
  needs and what each resolves to; this file only follows refs.
- A ref is resolved at most once (keyed by kind and id), so a cycle or a diamond ends and each part appears once.
- No silent fallback: a ref nothing resolves is unresolved and fails reference closure; a file with no hash fails it too.
  The bundle is never invented or half-made: a refused closure gives no bundle.
- A tier that requires a public closure (`public_tiers`, DATA, default ["public"]) may hold only parts marked
  `public_readable`, files and records alike; one private part in a public bundle fails at publish, not at fetch.
- No clock, no randomness, no network, no file read here: the caller supplies every resolution.

A ref is { kind, id }. A resolution is { ref, is_data?, value?, integrity_hash?, public_readable, dependencies?: [ref] }.
"""
from __future__ import annotations

import json

MANIFEST_VERSION = 'frozen-bundle/1'
DEFAULT_PUBLIC_TIERS = ('public',)


def ref_key(ref: dict) -> str:
    if not isinstance(ref, dict) or not isinstance(ref.get('kind'), str) or not isinstance(ref.get('id'), str) or not ref['kind'] or not ref['id']:
        raise ValueError(f'A ref is {{ kind, id }}, both words: {ref!r}')
    return f'{ref["kind"]}\u0000{ref["id"]}'


def canonical_bytes(value) -> bytes:
    """Sorted keys at every depth, no spaces: value equality is byte equality."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def freeze(spec: dict) -> dict:
    """{ ok, bundle, reference_issues, tier_issues } for a spec { tier, root, root_refs, resolutions, carried?, public_tiers? }.
    `bundle` is None unless ok."""
    if not isinstance(spec, dict):
        raise ValueError('Send an object.')
    for field in ('tier', 'root_refs', 'resolutions'):
        if field not in spec:
            raise ValueError(f'{field} is needed.')
    tier = spec['tier']
    if not isinstance(tier, str) or not tier:
        raise ValueError('tier is a word.')
    public_tiers = tuple(spec.get('public_tiers', DEFAULT_PUBLIC_TIERS))
    if not isinstance(spec['root_refs'], list) or not isinstance(spec['resolutions'], list):
        raise ValueError('root_refs and resolutions are lists.')
    known: dict[str, dict] = {}
    for resolution in spec['resolutions']:
        key = ref_key(resolution.get('ref') if isinstance(resolution, dict) else None)
        if key in known:
            raise ValueError(f'Two resolutions for one ref: {key!r}.')
        known[key] = resolution

    seen: set[str] = set()
    queue = list(spec['root_refs'])
    files: list[dict] = []
    records: list[dict] = []
    unresolved: list[dict] = []
    at = 0
    while at < len(queue):  # an index, not pop(0): the walk stays linear in parts and edges
        ref = queue[at]
        at += 1
        key = ref_key(ref)
        if key in seen:
            continue
        seen.add(key)
        resolution = known.get(key)
        if resolution is None:
            unresolved.append(ref)
            continue
        if resolution.get('is_data'):
            records.append({'ref': ref, 'value': resolution.get('value'), 'public_readable': resolution.get('public_readable') is True})
        else:
            files.append({'ref': ref, 'integrity_hash': resolution.get('integrity_hash') or '', 'public_readable': resolution.get('public_readable') is True})
        for dependency in resolution.get('dependencies') or []:
            if ref_key(dependency) not in seen:
                queue.append(dependency)

    files.sort(key=lambda row: ref_key(row['ref']))
    records.sort(key=lambda row: ref_key(row['ref']))
    reference_issues = [{'ref': ref, 'reason': 'unresolved'} for ref in unresolved]
    reference_issues += [{'ref': row['ref'], 'reason': 'file-missing-hash'} for row in files if not row['integrity_hash']]
    tier_issues = []
    if tier in public_tiers:
        tier_issues = [{'ref': row['ref'], 'reason': 'private-part-in-public-bundle'} for row in [*files, *records] if not row['public_readable']]
        tier_issues.sort(key=lambda issue: ref_key(issue['ref']))
    ok = not reference_issues and not tier_issues
    bundle = {
        'manifest_version': MANIFEST_VERSION, 'tier': tier, 'root': spec.get('root'), 'carried': spec.get('carried'),
        'files': files, 'records': records,
    } if ok else None
    return {'ok': ok, 'bundle': bundle, 'reference_issues': reference_issues, 'tier_issues': tier_issues}
