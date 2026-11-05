def build(pid, t0, t1, parts, slots, source, unit_id='u1', notes=None):
    """parts: list of ('K', text) or ('S', slot_id, text). Text is space-separated words."""
    tokens, n = [], 0
    for part in parts:
        mark, text = ('KEEP' if part[0] == 'K' else 'SLOT'), part[-1]
        for w in text.split():
            tok = {'id': f'{unit_id}/speech/{n}', 'unit': unit_id, 'region': 'speech', 'dims': {DIM: w},
                   'mark': mark, 'record': f'{unit_id}.p1', 'word': True, 'line': {DIM: f'{DIM}:L1'}}
            if mark == 'SLOT':
                tok.update({'slot': part[1], 'slot_type': slots[part[1]][0], 'slot_note': slots[part[1]][1],
                            'slot_dims': [DIM]})
            tokens.append(tok)
            n += 1
    used = {t['slot'] for t in tokens if t['mark'] == 'SLOT'}
    return {
        'schema': 'word-template@1',
        'piece': {'id': pid, 'medium': 'video', 'kind': 'reference',
                  'built_from': [{'reader': 'hand-written token table', 'path': source}],
                  'provenance': [{'op': 'hand_token_table', 'by': 'build_templates.py'}]},
        'registry': REG,
        'units': [{'id': unit_id, 'kind': 'shot', 't0': t0, 't1': t1, 'order': 1}],
        'lines': [{'id': f'{DIM}:L1', 'dim': DIM, 'job': None, 'tokens': [t['id'] for t in tokens]}],
        'slots': {k: {'type': slots[k][0], 'note': slots[k][1], 'rule': 'hand'} for k in slots if k in used},
        'tokens': tokens,
        'fills': {}, 'deleted': [], 'includes': [],
        'pending': [{'dim': d, 'reason': 'hand-written token table: only spoken words are written here'}
                    for d in ('drift.status',)],
        'conflicts': [], 'notes': {'language': 'en', **(notes or {})},
    }
