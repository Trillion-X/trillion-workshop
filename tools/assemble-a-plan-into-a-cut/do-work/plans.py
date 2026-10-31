"""Steps that change plans before a cut: regroup a plan's segments, apply a titles list, and print a plan's outline.

Every name a plan uses (its segment kinds, its title fields, its card prefixes) comes in the request; nothing here assumes a format.
"""
import json
from pathlib import Path

from fill import Refused


def _plan_path(folder, slug):
    path = Path(folder) / f'{slug}.json'
    if not path.is_file():
        raise Refused(f'{path} is not a plan file')
    return path


def _write(path, plan):
    path.write_text(json.dumps(plan, indent=1, ensure_ascii=False) + '\n')


def regroup(req):
    """Rebuild plans as groups: each group one new lead segment (given whole in DATA, such as a voiced line) followed by existing
    segments in the order given, each taking the group's member_kind and its label when the group gives one. Head and tail segments
    are kept unchanged. Indices are positions in the plan as it is now (the outline step prints them); every segment with a clip must
    be used exactly once.

    request: {"plans_folder", "shapes": {slug: {"head": [i], "groups": [{"lead": {segment}, "members": [i], "member_kind": kind,
              "labels": {"<i>": text}}], "tail": [i]}}, "label_key": "label", "structure": optional note written into each plan}"""
    label_key = req.get('label_key', 'label')
    done = []
    for slug, shape in req['shapes'].items():
        path = _plan_path(req['plans_folder'], slug)
        plan = json.loads(path.read_text())
        old = plan['segments']
        used = [i for g in shape['groups'] for i in g['members']] + shape.get('head', []) + shape.get('tail', [])
        clips = [i for i, s in enumerate(old) if s.get('clip')]
        missing = sorted(set(clips) - set(used))
        if missing or len(used) != len(set(used)):
            raise Refused(f'{slug}: segments with a clip must be used exactly once: missing {missing}, '
                          f'used twice {sorted({i for i in used if used.count(i) > 1})}')
        new = [old[i] for i in shape.get('head', [])]
        for g in shape['groups']:
            new.append(dict(g['lead']))
            for i in g['members']:
                seg = {k: v for k, v in old[i].items() if k != label_key}
                seg['kind'] = g['member_kind']
                label = g.get('labels', {}).get(str(i))
                if label:
                    seg[label_key] = label
                new.append(seg)
        new += [old[i] for i in shape.get('tail', [])]
        plan['segments'] = new
        if req.get('structure'):
            plan['structure'] = req['structure']
        _write(path, plan)
        chains = [round(sum(old[i]['to'] - old[i]['from'] for i in g['members'] if old[i].get('clip')), 3) for g in shape['groups']]
        done.append({'slug': slug, 'groups': len(shape['groups']), 'group_seconds': chains, 'segments': len(new)})
    return {'plans': done}


def retitle(req):
    """Apply a titles list to every plan in a folder: each plan's title row (by plan id) gives its new title and the fields named in
    copy_from_row; the titles document gives the fields named in copy_from_doc. A card segment whose text is an old title, or one of
    card_prefixes plus an old title, gets the new title. A title in `untitled` (words such as a placeholder) becomes the plan's title,
    the withdrawn title is kept under fields.withdrawn, and its cards are left as they are. A row may name the old_title of a plan that
    does not exist, so cards pointing at it are renamed too.

    request: {"plans_folder", "titles": {"titles": [{"id", "title", "old_title"?, ...}], ...}, "untitled": [...], "card_kind": kind,
              "card_prefixes": [...], "copy_from_row": [...], "copy_from_doc": [...], "fields": {"title": "title", "withdrawn": "withdrawn_title"}}"""
    fields = {'title': 'title', 'withdrawn': 'withdrawn_title', **req.get('fields', {})}
    title, withdrawn = fields['title'], fields['withdrawn']
    untitled = set(req.get('untitled', []))
    doc = req['titles']
    rows = {t['id']: t for t in doc['titles']}
    plans = {p: json.loads(p.read_text()) for p in sorted(Path(req['plans_folder']).glob('*.json'))}
    unknown = sorted(plan['id'] for plan in plans.values() if plan['id'] not in rows)
    if unknown:
        raise Refused(f'plans {", ".join(unknown)} have no row in the titles list')
    rename = {t['old_title']: t['title'] for t in rows.values() if t.get('old_title') and t['title'] not in untitled}
    for plan in plans.values():
        new = rows[plan['id']]
        if new['title'] not in untitled:
            rename[plan[title]] = new['title']
    out = []
    for path, plan in plans.items():
        new = rows[plan['id']]
        for k in req.get('copy_from_row', []):
            plan[k] = new[k]
        if new['title'] in untitled:
            if plan[title] not in untitled:
                plan[withdrawn] = plan[title]
            plan[title] = new['title']
        else:
            plan[title] = rename.get(plan[title], plan[title])
            plan.pop(withdrawn, None)
        for k in req.get('copy_from_doc', []):
            if doc.get(k):
                plan[k] = doc[k]
        for seg in plan['segments']:
            if seg['kind'] != req['card_kind']:
                continue
            text = seg['text']
            if text in rename:
                seg['text'] = rename[text]
                continue
            for prefix in req.get('card_prefixes', []):
                if text.startswith(prefix) and text[len(prefix):] in rename:
                    seg['text'] = prefix + rename[text[len(prefix):]]
                    break
        _write(path, plan)
        out.append({'id': plan['id'], 'title': plan[title], **{k: plan.get(k) for k in req.get('copy_from_row', [])}})
    return {'plans': out}


def outline(req):
    """each plan as a numbered outline: segment index, kind, clip, seconds, text; and the recorded seconds in all"""
    out = []
    for path in req['plan_files']:
        plan = json.loads(Path(path).read_text())
        rows = [{'i': i, 'kind': s['kind'], 'clip': s.get('clip'), 'seconds': round(s['to'] - s['from'], 3) if s.get('clip') else None,
                 'text': s.get('text', '')} for i, s in enumerate(plan['segments'])]
        out.append({'slug': plan.get('slug'), 'recorded_seconds': round(sum(r['seconds'] or 0 for r in rows), 3), 'segments': rows})
    return {'plans': out}
