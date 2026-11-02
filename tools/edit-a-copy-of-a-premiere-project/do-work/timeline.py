"""Restructure a sequence: cut, move and assemble ranges across every track.

One engine does all three. The output timeline is a list of ranges of the
current timeline, in output order. Every video/audio item is razored at every
range boundary; each piece then lands at its range's output position or is
deleted. Captions keep their words: a caption lands with the range holding its
start and is shortened where its range ends. A full-length adjustment layer is
re-sized to the new length, never razored, so its effect stack stays one stack.
Linked picture/sound pieces stay linked.

cut(a, b)        = assemble [0, a) + [b, end)
move(a, b, to)   = assemble with [a, b) taken out and put back at `to`
assemble(ranges) = the ranges, in the given order; anything not in a range is deleted

Ranges can be given as sequence timecodes, as a source range of a clip
({"clip": "C9940", "src_in": 14.24, "src_out": 21.83}, seconds) or as an
insert made earlier in the plan ({"insert": "c1"}).
"""
import re

from prproj import TPS, clip_track_item, parse_tc, tc

SHARED_REF_TAGS = {'Source', 'Markers', 'Content', 'MasterClip'}
BLOCK = re.compile(r'\n\t<(\w[\w.]*) Object(U?)ID="([^"]+)"[^>]*>.*?\n\t</\1>', re.S)


# ---------------------------------------------------------------- reading the timeline

def media_title(p, cti):
    sub = p.ref(cti.find('SubClip'))
    if sub is None:
        return None
    clip = p.ref(sub.find('Clip'))
    src = p.ref(clip.find('Clip/Source')) if clip is not None else None
    media = p.ref(src.find('MediaSource/Media')) if src is not None else None
    return media.findtext('Title') if media is not None else None


def clip_of(p, cti):
    return p.ref(p.ref(cti.find('SubClip')).find('Clip'))


def items(ed, label):
    """[(oid, start, end, in_ticks, title)] of a track, sorted by start."""
    out = []
    for oid, s, e, cti in ed.p.track_items(ed.tracks[label]):
        title, cin = None, None
        if cti.find('SubClip') is not None:
            title = media_title(ed.p, cti)
            clip = clip_of(ed.p, cti)
            cin = int(clip.findtext('Clip/InPoint') or 0) if clip is not None else None
        out.append((oid, s, e, cin, title))
    return sorted(out, key=lambda x: x[1])


def stem(title):
    return (title or '').rsplit('.', 1)[0].lower()


def src_ticks(seconds, tpf):
    """Source seconds -> ticks on the nearest frame."""
    return round(seconds * TPS / tpf) * tpf


def inserted_ids(ed):
    return {i for ids in ed.insert_items.values() for i in ids}


def resolve(ed, spec):
    """A range spec -> (a, b) ticks on the current timeline, plus the insert items it carries."""
    tpf = ed.tpf
    if 'insert' in spec:
        span = insert_spans(ed).get(spec['insert'])
        if span is None:
            raise ValueError(f'no insert "{spec["insert"]}" was made in this plan')
        return span[0], span[1], set(ed.insert_items[spec['insert']])
    if 'from' in spec:
        return parse_tc(spec['from'], tpf) * tpf, parse_tc(spec['to'], tpf) * tpf, set()
    clip, t_in, t_out = stem(spec['clip']), src_ticks(spec['src_in'], tpf), src_ticks(spec['src_out'], tpf)
    if t_out <= t_in:
        raise ValueError(f'empty source range {spec}')
    track = spec.get('track', 'V1')
    row = items(ed, track)
    carried_ids = inserted_ids(ed)
    gaps = {(a, b): set(ed.insert_items[name]) for name, (a, b) in insert_spans(ed).items()}
    found = []
    for i, (oid, s, e, cin, title) in enumerate(row):
        if stem(title) != clip or cin is None or not (cin <= t_in < cin + (e - s)):
            continue
        last, src_end, carried, j = row[i], cin + (e - s), set(), i + 1
        while t_out > src_end and j < len(row):
            nid, ns, ne, ncin, ntitle = row[j]
            if ns != row[j - 1][2]:
                # a hole ends the run, unless an insert fills exactly that hole on other tracks
                hole = gaps.get((row[j - 1][2], ns))
                if hole is None:
                    break
                carried |= hole
            if nid in carried_ids:
                carried.add(nid)
            elif stem(ntitle) == clip and ncin == src_end:
                last, src_end = row[j], ncin + (ne - ns)
            else:
                break
            j += 1
        if t_out <= src_end:
            a = s + (t_in - cin)
            b = last[1] + (t_out - last[3])
            found.append((a, b, {c for c in carried if inside(ed, c, a, b)}))
    if not found:
        raise ValueError(f'source range {spec} is not on {track} as one unbroken run')
    if len(found) > 1:
        ed.log.append(f'  note: {spec.get("label", spec["clip"])} {spec["src_in"]}-{spec["src_out"]} occurs '
                      f'{len(found)} times; using the first at {tc(found[0][0], tpf)}')
    return found[0]


def insert_spans(ed):
    """insert id -> (start, end) over all its pieces on any track."""
    where = {}
    for label in ed.tracks:
        for oid, s, e, _, _ in items(ed, label):
            where[oid] = (s, e)
    out = {}
    for name, ids in ed.insert_items.items():
        spans = [where[i] for i in ids if i in where]
        if spans:
            out[name] = (min(s for s, _ in spans), max(e for _, e in spans))
    return out


def inside(ed, oid, a, b):
    for label in ed.tracks:
        for i, s, e, _, _ in items(ed, label):
            if i == oid:
                return a <= s and e <= b
    return False


# ---------------------------------------------------------------- the engine

def assemble(ed, specs):
    """Rebuild the sequence from ranges of the current timeline, in the given order."""
    tpf = ed.tpf
    resolved, carried = {}, set()
    for n, spec in enumerate(specs):
        if 'insert' not in spec:
            resolved[n] = resolve(ed, spec)
            carried |= resolved[n][2]
    ranges = []
    for n, spec in enumerate(specs):
        if 'insert' in spec:
            if set(ed.insert_items.get(spec['insert'], [])) & carried:
                ed.log.append(f'  insert {spec["insert"]} rides inside a source range already; not placed twice')
                continue
            resolved[n] = resolve(ed, spec)
        a, b, _ = resolved[n]
        if b > a:
            ranges.append((a, b, spec.get('label', spec.get('insert', ''))))
    ordered = sorted(ranges)
    for (a1, b1, l1), (a2, b2, l2) in zip(ordered, ordered[1:]):
        if a2 < b1:
            raise ValueError(f'ranges overlap: {l1} {tc(a1, tpf)}-{tc(b1, tpf)} and {l2} {tc(a2, tpf)}-{tc(b2, tpf)}')
    for name, ids in ed.insert_items.items():
        if not any(inside(ed, ids[0], a, b) for a, b, _ in ranges):
            raise ValueError(f'insert {name} is in no range and would be deleted; list it or leave it out of the plan')
    remap(ed, ranges)


def cut(ed, a, b):
    end = timeline_end(ed)
    assemble_ticks(ed, [(0, a, 'before cut'), (b, end, 'after cut')])


def move(ed, a, b, to):
    end = timeline_end(ed)
    if a <= to <= b:
        raise ValueError('move target is inside the moved range')
    if to < a:
        parts = [(0, to), (a, b), (to, a), (b, end)]
    else:
        parts = [(0, a), (b, to), (a, b), (to, end)]
    assemble_ticks(ed, [(x, y, 'move') for x, y in parts])


def assemble_ticks(ed, ranges):
    remap(ed, [r for r in ranges if r[1] > r[0]])


def timeline_end(ed):
    return max((e for label in ed.tracks for _, _, e, _, _ in items(ed, label)), default=0)


def remap(ed, ranges):
    """ranges: [(a, b, label)] of the current timeline in output order; (None, length, label)
    leaves an empty gap of that length. Returns the output start of each entry."""
    tpf = ed.tpf
    p = ed.p
    old_end = timeline_end(ed)
    cuts = sorted({x for a, b, _ in ranges if a is not None for x in (a, b)})
    out_at, pos = [], 0
    for a, b, _ in ranges:
        out_at.append(pos)
        pos += b if a is None else b - a
    total = pos
    real = [(i, a, b) for i, (a, b, _) in enumerate(ranges) if a is not None]

    # 1. razor every video/audio item (not adjustment layers) at every boundary
    lineage, rows = {}, {}
    for label in ed.tracks:
        rows[label] = []
        for oid, s, e, _, _ in items(ed, label):
            inner = [c for c in cuts if s < c < e]
            cti = clip_track_item(p.by_id[oid])
            if label[0] != 'D' and inner and not p.is_adjustment_layer(cti):
                lineage[oid] = razor_multi(ed, oid, s, e, inner)
                rows[label] += lineage[oid]
            else:
                rows[label].append((oid, s, e))
    ed.flush()

    # 2. where each item lands
    def place(s, e):
        for i, a, b in real:
            if a <= s and e <= b:
                return out_at[i] + (s - a), out_at[i] + (e - a)
        return None

    def contiguous(i, j):
        """Entry j follows entry i in the output and continues the same timeline."""
        (ai, bi, _), (aj, _, _) = ranges[i], ranges[j]
        return j == i + 1 and ai is not None and aj == bi and out_at[j] == out_at[i] + (bi - ai)

    def place_caption(s, e):
        """A caption lands with the range holding most of it, and runs on through ranges
        that continue it seamlessly; it is shortened where the run ends."""
        best = max(real, key=lambda r: min(e, r[2]) - max(s, r[1]), default=None)
        if best is None or min(e, best[2]) - max(s, best[1]) <= 0:
            return None
        i, a, b = best
        k = i
        while k > 0 and s < ranges[k][0] and contiguous(k - 1, k):
            k -= 1
        ns = out_at[k] + (max(s, ranges[k][0]) - ranges[k][0])
        j = i
        while e > ranges[j][1] and j + 1 < len(ranges) and contiguous(j, j + 1):
            j += 1
        ne = out_at[j] + (min(e, ranges[j][1]) - ranges[j][0])
        return (ns, ne) if ne - ns >= tpf else None

    moves, deletes, track_lists = {}, set(), {}
    for label, uid in ed.tracks.items():
        kept = []
        for oid, s, e in rows[label]:
            cti = clip_track_item(p.by_id[oid])
            if label[0] == 'V' and p.is_adjustment_layer(cti):
                if s != 0 or e < old_end:
                    raise ValueError(f'adjustment layer {oid} does not span the whole sequence; '
                                     'only full-length adjustment layers can be carried')
                moves[oid] = (0, total, total - (e - s))
                kept.append((0, oid))
                continue
            where = place_caption(s, e) if label[0] == 'D' else place(s, e)
            if where is None:
                deletes.add(oid)
                continue
            moves[oid] = (where[0], where[1], (where[1] - where[0]) - (e - s))
            kept.append((where[0], oid))
        track_lists[uid] = [oid for _, oid in sorted(kept)]

    # 3. write times (one pass), clip lengths for adjustment layers and captions that changed length
    clip_bumps = {}
    for oid, (ns, ne, grow) in moves.items():
        if grow:
            cti = clip_track_item(p.by_id[oid])
            if cti.find('SubClip') is not None and p.is_adjustment_layer(cti):
                clip_bumps[clip_of(p, cti).attrib['ObjectID']] = grow
    rewrite(ed, {oid: (lambda b, ns=ns, ne=ne: set_times(b, ns, ne)) for oid, (ns, ne, _) in moves.items()} |
            {cid: (lambda b, g=g: bump(b, 'OutPoint', g)) for cid, g in clip_bumps.items()})
    links = relink(ed, lineage, deletes)
    delete_objects(ed, deletes)
    for uid, ids in track_lists.items():
        set_track_list(ed, uid, ids)
    set_links(ed, links)
    p.reparse()
    ed.log.append(f'  {len(ranges)} ranges, {len(lineage)} items razored, {len(deletes)} items removed, '
                  f'length {tc(old_end, tpf)} -> {tc(total, tpf)}')
    return out_at


# ---------------------------------------------------------------- razor, links, deletion

def razor_multi(ed, oid, s, e, inner):
    """Cut an item at each tick in `inner`; returns [(piece_id, start, end)] in time order."""
    p = ed.p
    cti = clip_track_item(p.by_id[oid])
    clip = clip_of(p, cti)
    cin = int(clip.findtext('Clip/InPoint') or 0)
    if clip.findtext('Clip/OutPoint') is None:
        raise ValueError(f'item {oid} has no clip out point; cannot razor it')
    bounds = [s] + inner + [e]
    pieces = [(oid, bounds[0], bounds[1])]
    for k in range(1, len(bounds) - 1):
        mapping = {}
        new = ed.clone(oid, mapping)
        new_clip = mapping[clip.attrib['ObjectID']]
        ps, pe = bounds[k], bounds[k + 1]
        for i, block in enumerate(ed.pending):
            head = block.split('\n', 1)[0]
            if f'ObjectID="{new}"' in head:
                ed.pending[i] = set_times(block, ps, pe)
            elif f'ObjectID="{new_clip}"' in head:
                ed.pending[i] = set_point(set_point(block, 'InPoint', cin + ps - s), 'OutPoint', cin + pe - s)
        pieces.append((new, ps, pe))
    first_out = bounds[1]
    p.edit('ObjectID', oid, lambda b: set_times(b, s, first_out))
    p.edit('ObjectID', clip.attrib['ObjectID'], lambda b: set_point(b, 'OutPoint', cin + first_out - s))
    return pieces


def relink(ed, lineage, deletes):
    """Links after razoring: pieces with the same original span stay linked."""
    p = ed.p
    result = []
    for el in [e for e in p.by_id.values() if e.tag == 'Link']:
        members = [t.attrib['ObjectRef'] for t in el.iter('TrackItem')]
        spans = {}
        for m in members:
            for piece, s, e in lineage.get(m, [(m, None, None)]):
                spans.setdefault((s, e), []).append(piece)
        first = True
        for key, group in spans.items():
            alive = [g for g in group if g not in deletes]
            result.append((el.attrib['ObjectID'] if first else None, alive))
            first = False
    return result


def set_links(ed, links):
    p = ed.p
    keep_ids, drop_ids = [], []
    for link_id, members in links:
        rows = ''.join(f'\t\t\t\t<TrackItem Index="{i}" ObjectRef="{m}"/>\n' for i, m in enumerate(members))
        if len(members) < 2:
            if link_id:
                drop_ids.append(link_id)
            continue
        if link_id:
            a, b = p.span('ObjectID', link_id)
            p.text = p.text[:a] + re.sub(r'(<TrackItems Version="1">\n).*?(\t+</TrackItems>)',
                                         lambda m: m.group(1) + rows + m.group(2), p.text[a:b],
                                         count=1, flags=re.S) + p.text[b:]
            keep_ids.append(link_id)
        else:
            keep_ids.append(ed.add_link(members))
    ed.flush()
    if drop_ids:
        rewrite(ed, {}, delete=set(drop_ids))
    if '<Links Version="1">' not in p.block('ObjectUID', ed.seq_uid):
        if keep_ids:
            raise RuntimeError('sequence has no link container for the links it needs')
        return
    rows = ''.join(f'\t\t\t\t\t<Link Index="{i}" ObjectRef="{lid}"/>\n' for i, lid in enumerate(keep_ids))
    s, e = p.span('ObjectUID', ed.seq_uid)
    p.text = p.text[:s] + re.sub(r'(<Links Version="1">\n).*?(\t+</Links>)', lambda m: m.group(1) + rows + m.group(2),
                                 p.text[s:e], count=1, flags=re.S) + p.text[e:]


def owned(p, oid, acc):
    if oid in acc or oid not in p.by_id:
        return
    acc.add(oid)
    for child in p.by_id[oid].iter():
        r = child.attrib.get('ObjectRef')
        if r and child.tag not in SHARED_REF_TAGS:
            owned(p, r, acc)


def delete_objects(ed, item_ids):
    """Delete track items and the objects only they own."""
    p = ed.p
    candidates = set()
    for oid in item_ids:
        owned(p, oid, candidates)
    refs = {}
    for m in re.finditer(r'ObjectRef="(\d+)"', p.text):
        refs[m.group(1)] = refs.get(m.group(1), 0) + 1
    inner = {}
    for oid in candidates:
        for child in p.by_id[oid].iter():
            r = child.attrib.get('ObjectRef')
            if r:
                inner[r] = inner.get(r, 0) + 1
    # an item is referenced by its track list (rewritten) and maybe a link (rewritten)
    doomed = set(item_ids)
    for oid in candidates - set(item_ids):
        if refs.get(oid, 0) == inner.get(oid, 0):
            doomed.add(oid)
    rewrite(ed, {}, delete=doomed)


def rewrite(ed, edits, delete=frozenset()):
    """One pass over the top-level objects: apply edits by ObjectID, drop deleted ones."""
    text = ed.p.text
    out, last = [], 0
    for m in BLOCK.finditer(text):
        key = m.group(3)
        if key in delete:
            out.append(text[last:m.start()])
            last = m.end()
        elif key in edits:
            out.append(text[last:m.start()])
            out.append(edits[key](m.group(0)))
            last = m.end()
    out.append(text[last:])
    ed.p.text = ''.join(out)
    ed.p.reparse()


def set_track_list(ed, uid, ids):
    def fn(block):
        m = re.search(r'\n(\t+)<ClipItems Version="3">\n', block)
        ind = m.group(1)
        block = re.sub(r'\n\t+<TrackItems Version="1">\n.*?\n\t+</TrackItems>', '', block, count=1, flags=re.S)
        if not ids:
            return block
        rows = ''.join(f'{ind}\t\t<TrackItem Index="{i}" ObjectRef="{o}"/>\n' for i, o in enumerate(ids))
        return block.replace(m.group(0), m.group(0) + f'{ind}\t<TrackItems Version="1">\n{rows}{ind}\t</TrackItems>\n', 1)
    s, e = ed.p.span('ObjectUID', uid)
    ed.p.text = ed.p.text[:s] + fn(ed.p.text[s:e]) + ed.p.text[e:]


# ---------------------------------------------------------------- small text edits

def set_times(block, start, end):
    m = re.search(r'(<TrackItem Version="4">.*?)(</TrackItem>)', block, re.S)
    inner = m.group(1)
    indent = re.search(r'\n(\t+)<End>', inner).group(1)
    inner = re.sub(r'\n\t+<Start>\d+</Start>', '', inner, count=1)
    start_row = f'\n{indent}<Start>{start}</Start>' if start else ''
    inner = re.sub(r'\n\t+<End>\d+</End>', f'{start_row}\n{indent}<End>{end}</End>', inner, count=1)
    return block[:m.start()] + inner + m.group(2) + block[m.end():]


def set_point(block, tag, value):
    if f'<{tag}>' not in block:
        raise RuntimeError(f'clip has no <{tag}>')
    return re.sub(rf'<{tag}>\d+</{tag}>', f'<{tag}>{value}</{tag}>', block, count=1)


def bump(block, tag, by):
    return re.sub(rf'<{tag}>(\d+)</{tag}>', lambda m: f'<{tag}>{int(m.group(1)) + by}</{tag}>', block, count=1)
