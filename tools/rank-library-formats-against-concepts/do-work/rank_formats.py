

def medium_of(kind, aspect):
    aspect = aspect.lower()
    if kind == 'long-form X article' or aspect == 'text':
        return 'write-up'
    if 'carousel' in aspect or kind == 'slideshow / carousel':
        return 'carousel'
    if kind == 'multi-panel grid':
        return 'post'
    if 'long video' in aspect or kind == 'long-form episode / talk / keynote':
        return 'long video'
    if 'web loop' in aspect:
        return 'web loop'
    return 'short'


def what_it_is(folder):
    path = ROOT / 'library' / folder / 'FORMAT.md'
    if not path.exists():
        return ''
    found = re.search(r'\*\*What it is\.\*\*(.{0,400})', path.read_text(errors='replace'), re.S)
    return ' '.join(found.group(1).split('\n\n')[0].split()) if found else ''


def candidates():
    rows, on = [], False
    for line in (ROOT / 'library/INDEX.md').read_text().splitlines():
        if line.startswith('## All items'):
            on = True
            continue
        if on and line.startswith('## '):
            break
        if not on or not line.startswith('| ') or line.startswith('| creator') or line.startswith('|---'):
            continue
        cells = [c.strip() for c in line.strip('|').split('|')]
        if len(cells) < 12 or cells[2].startswith('see'):
            continue
        folder = re.search(r'(formats/[^)\s]+)', cells[11])
        if not folder:
            continue
        folder = folder.group(1).rstrip('/')
        name = folder.split('/')[-1]
        rows.append({'key': STABLE.get(name, name), 'type': cells[2], 'medium': medium_of(cells[2], cells[3]), 'creator': cells[0],
                     'path': f'library/{folder}/', 'stats': f'{cells[4]} s, {cells[7]} views, {cells[8]} likes, {cells[9]} bookmarks',
                     'text': f'{cells[1]}: {what_it_is(folder) or cells[10]}'})
    for line in BANK.read_text().splitlines():
        cells = [c.strip() for c in line.strip('|').split('|')]
        if len(cells) >= 8 and cells[0] in FORM_TEMPLATES and '(' in cells[2]:
            name, form = FORM_TEMPLATES[cells[0]]
            rows.append({'key': f'title_template_{cells[0]}', 'type': 'title template (a form)', 'medium': 'long video or short', 'creator': 'bank',
                         'path': f'title-template-bank.md template {cells[0]} (tools/provenance-lists templates list)',
                         'stats': f'{cells[2]} outliers', 'text': f'{name}: {form}'})
    return rows + HIS_OWN


def concepts():
    found = {}
    for path in sorted((SLATE / 'moment-search').glob('group-*.md')):
        current = None
        for line in path.read_text().splitlines():
            head = re.match(r'^## ([A-Z]+\d+)(?: \||) (?:\([A-Za-z]+\) )?(.+)$', line)
            if head:
                current = head.group(1)
                found[current] = {'title': head.group(2), 'beats': [], 'n': 0, 'local': 0, 'b2': 0}
                continue
            if current and line.startswith('| ') and not line.startswith(('| beat', '| concept', '|---')):
                cells = [c.strip() for c in line.strip('|').split('|')]
                found[current]['beats'].append(re.sub(r'^(HOOK|hook|Q):?\s*', '', cells[1] if cells[0] == current else cells[0]))
                found[current]['n'] += 1
                found[current]['local'] += 'local' in line
                found[current]['b2'] += ' b2' in line.lower() or '| B2' in line
    if PACKAGE and PACKAGE.exists():
        for row in csv.DictReader(open(PACKAGE)):
            if row['id'] in ('V13', 'V15'):
                found[row['id']] = {'title': row['domain'], 'beats': [row['viewer_gets'], row['proof_needed']], 'n': 0, 'local': 0, 'b2': 0}
    found.pop('A09', None)
    return found


def main():
    cands, ideas = candidates(), concepts()
    if MODE == 'catalog':
        for c in cands:
            print('\t'.join(['F', c['key'], c['type'], c['medium'], c['creator'], c['stats'], c['text']]))
        for cid, idea in sorted(ideas.items()):
            print('\t'.join(['C', cid, idea['title'], str(idea['n']), str(idea['local']), '; '.join(idea['beats'][:8])]))
        return
    by_key = {c['key']: c for c in cands}
    judged = {}
    for path in JUDGED:
        judged.update(json.loads(path.read_text()))
    unknown = sorted({o['format'] for opts in judged.values() for o in opts} - set(by_key))
    if unknown:
        sys.exit(f'refused: keys not in the catalog: {unknown}')
    missing = sorted(set(ideas) - set(judged))
    if missing:
        sys.exit(f'refused: concepts not judged: {missing}')
    doc = json.loads(TITLES.read_text())
    options = {}
    for cid, opts in judged.items():
        idea = ideas[cid]
        options[cid] = [{'format': o['format'], 'type': by_key[o['format']]['type'], 'medium': by_key[o['format']]['medium'],
                         'path': by_key[o['format']]['path'], 'fit': o['fit'],
                         'material': o.get('material', 'his recorded words for this concept and their transcripts'),
                         'moments_fit': idea['n'], 'moments_local': idea['local'], 'moments_b2': idea['b2'],
                         'moments_drive': idea['n'] - idea['local'] - idea['b2']} for o in opts]
    used = {o['format'] for opts in options.values() for o in opts} | {c[0] for c in doc.get('format_chosen', {}).values()}
    doc['format_palette'] = {k: {'type': by_key[k]['type'], 'medium': by_key[k]['medium'], 'path': by_key[k]['path'], 'note': by_key[k]['text'][:300]}
                             for k in sorted(used)}
    doc['format_options'] = {**options, 'A09': []}
    doc.pop('format_ranking', None)
