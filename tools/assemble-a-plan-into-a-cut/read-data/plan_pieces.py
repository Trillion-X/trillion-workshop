"""Which piece each segment of a plan becomes, which aspects the plan is made in, and the one key of a recorded span.

The piece table is DATA (the request's "pieces"):
  default             {segment kind: piece row} for every format
  formats             {format option: {segment kind: piece row}} laid over default; a format with no row is not renderable
  aspects_by_medium   {medium: ["<ratio> <width>x<height>", ...]}
A piece row is {"piece": <piece>, ...}. The pieces are what the cutter knows how to make (code): clip (a recording from-to),
voiced_line (a voiced line over a held frame), skip (not cut), slide (one still per segment, the plan becomes slides).
"""
from fill import Refused

PIECES = ('clip', 'voiced_line', 'skip', 'slide')
STILL_PIECES = {'slide'}


def pieces_of(plan, table):
    """{segment kind: piece row} for a plan: default overlaid by the row of the plan's format.option. A format with no row is refused,
    and so is a segment kind the table does not name or a piece the cutter does not make."""
    fmt = (plan.get('format') or {}).get('option')
    if fmt not in table['formats']:
        raise Refused(f"{plan.get('slug')}: format {fmt} is not renderable yet (the piece table has no row for it)")
    rows = {**table.get('default', {}), **table['formats'][fmt]}
    unknown = sorted({s['kind'] for s in plan['segments']} - set(rows))
    if unknown:
        raise Refused(f"{plan.get('slug')}: segment kind {', '.join(unknown)} has no piece for format {fmt} in the piece table")
    odd = sorted({rows[s['kind']]['piece'] for s in plan['segments']} - set(PIECES))
    if odd:
        raise Refused(f"{plan.get('slug')}: piece {', '.join(odd)} is not one the cutter makes ({', '.join(PIECES)})")
    return rows


def aspects_of(plan, table):
    """[(label, width, height)] the plan is made in: aspects_by_medium[format.medium], then the plan's own format.aspects_also"""
    fmt = plan.get('format') or {}
    if fmt.get('medium') not in table['aspects_by_medium']:
        raise Refused(f"{plan.get('slug')}: medium {fmt.get('medium')} has no aspects in the piece table")
    out = []
    for label in [*table['aspects_by_medium'][fmt['medium']], *fmt.get('aspects_also', [])]:
        w, h = map(int, label.split()[1].split('x'))
        if (label, w, h) not in out:
            out.append((label, w, h))
    return out


def is_slides(plan, rows):
    """True when every piece of the plan is a still, False when none is; a plan that mixes stills and cuts is refused"""
    kinds = {rows[s['kind']]['piece'] for s in plan['segments']} - {'skip'}
    if kinds & STILL_PIECES and kinds - STILL_PIECES:
        raise Refused(f"{plan.get('slug')}: pieces {', '.join(sorted(kinds))} mix stills and cuts; a plan is all slides or all film")
    return bool(kinds & STILL_PIECES)


def span_key(s):
    """the one key of a recorded span, the same for the same cut in any plan: <clip>_<from>_<to>, seconds to 2 places. Audio grade
    rows are keyed by it."""
    return f"{s['clip']}_{s['from']:.2f}_{s['to']:.2f}"
