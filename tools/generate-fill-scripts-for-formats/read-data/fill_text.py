"""Fill one format's script template with one capability, and lay out the pages. Pure: no files, no clock, no network.

Nothing about any format, product or person is known here. A format's lines, slots, shoot cards and notes, every page's words,
and the capabilities' own words are the person's DATA, given in the request. This module only fills templates, counts words and
lays out the tables.

A hole is a fact the script cannot know yet: `<<n|label|what fills it>>`, where n is the number of words the filled hole will
take. A hole shows on the page as `[label]`, counts as n words, and is listed with what would fill it.

A template value (V) is one of:
  "text with {path}"                 the text with each {dotted.path} filled from the context (a number indexes a list);
                                     a path that holds nothing is refused by name
  {"if": PATH, "then": V, "else": V} `then` when the path holds a non-empty value, else `else` (nothing when there is none)
  {"each": PATH, "as": NAME, "item": V, "sep": TEXT, "empty": V}
                                     `item` for every element of the list at PATH, the element named NAME; joined with `sep`
                                     when given, else a list of lines; `empty` when the list is empty
  {"replace": V, "old": TEXT, "new": TEXT}   the text with every `old` replaced by `new`
  {"after": V, "sep": TEXT}                   what follows the first `sep` in the text
  {"concat": [V, ...]}                        the texts one after another
A page is a list of V: a value that is a list adds each of its lines, a value that is nothing adds no line.
"""
from __future__ import annotations

import re
from typing import Any

HOLE = re.compile(r"<<(\d+)\|([^|>]+)\|([^>]+)>>")
PLACE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\}")
COUNTERS = ('words', 'quoted-words')


class TemplateError(ValueError):
    pass


def render(text: str) -> str:
    """The text as it shows on the page: every hole is its [label]."""
    return HOLE.sub(lambda m: f"[{m.group(2)}]", text)


def holes(text: str) -> list[tuple[str, str]]:
    return [(m.group(2), m.group(3)) for m in HOLE.finditer(text)]


def words(text: str) -> int:
    """Words said: each hole counts as the words it will take, any other word that holds a letter or digit as one."""
    n = sum(int(m.group(1)) for m in HOLE.finditer(text))
    rest = HOLE.sub(" ", text)
    return n + sum(1 for w in rest.split() if re.search(r"[A-Za-z0-9]", w))


def quoted_words(text: str) -> int:
    """Words on screen: the words inside double quotes plus the holes outside them; directions outside quotes are not shown."""
    n = sum(words(q) for q in re.findall(r'"([^"]*)"', text))
    outside = re.sub(r'"[^"]*"', " ", text)
    return n + sum(int(m.group(1)) for m in HOLE.finditer(outside))


COUNT = {'words': words, 'quoted-words': quoted_words}


def escape_cell(text: str) -> str:
    return text.replace("|", "\\|")


def dig(context: Any, path: str):
    value = context
    for part in path.split('.'):
        if isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            return None
    return value


def present(value: Any) -> bool:
    return value not in (None, '', [], {})


def fill_text(text: str, context: dict) -> str:
    def one(m: re.Match) -> str:
        value = dig(context, m.group(1))
        if value is None or isinstance(value, (dict, list)):
            raise TemplateError(f'{{{m.group(1)}}} holds no text here; give it in the request, or put the line under an "if".')
        return str(value)
    return PLACE.sub(one, text)


def evaluate(template: Any, context: dict):
    """A template value's text, list of lines, or None."""
    if template is None:
        return None
    if isinstance(template, str):
        return fill_text(template, context)
    if not isinstance(template, dict):
        raise TemplateError(f'A template is text or one of if, each, replace, after, concat; got {template!r}.')
    if 'if' in template:
        branch = template.get('then') if present(dig(context, template['if'])) else template.get('else')
        return evaluate(branch, context)
    if 'each' in template:
        items = dig(context, template['each'])
        if items is None:
            items = []
        if not isinstance(items, list):
            raise TemplateError(f'"each": {template["each"]} is not a list.')
        if not items and 'empty' in template:
            return evaluate(template['empty'], context)
        name = template.get('as', 'item')
        made = [evaluate(template['item'], {**context, name: item}) for item in items]
        made = [m for m in made if m is not None]
        return template['sep'].join(made) if 'sep' in template else made
    if 'replace' in template:
        return str(evaluate(template['replace'], context)).replace(template['old'], template['new'])
    if 'concat' in template:
        return ''.join(str(evaluate(part, context) or '') for part in template['concat'])
    if 'after' in template:
        text = str(evaluate(template['after'], context))
        if template['sep'] not in text:
            raise TemplateError(f'"after": the text has no {template["sep"]!r} to cut after: {text[:80]!r}.')
        return text.split(template['sep'], 1)[1]
    raise TemplateError(f'A template is text or one of if, each, replace, after, concat; got keys {sorted(template)}.')


def page(lines: list, context: dict) -> str:
    out: list[str] = []
    for template in lines:
        value = evaluate(template, context)
        if value is None:
            continue
        out.extend(value if isinstance(value, list) else [value])
    return "\n".join(out) + "\n"


def others_of(cap: dict, capabilities: list[dict], rule: dict | None) -> list[dict]:
    """The other capabilities of the batch, those holding `present_first` first (each group in batch order), at most `limit`."""
    if not rule:
        return []
    rest = [c for c in capabilities if c['cap']['key'] != cap['key']]
    if rule.get('present_first'):
        rest = sorted(rest, key=lambda c: not present(c['cap'].get(rule['present_first'])))
    return rest[:rule['limit']] if 'limit' in rule else rest


def signed(n: float) -> str:
    return f"{n:+.0f}"


def fill(fmt: dict, entry: dict, batch: list[dict], settings: dict) -> dict:
    """One filled page of a format for one capability, with its word count, budget and open holes."""
    template = fmt['template']
    count = COUNT[template.get('count', 'words')]
    context = {'settings': settings, 'format': fmt, 'cap': entry['cap'], 'listing': entry['listing'],
               'listing_file': entry['listing_file'],
               'others': others_of(entry['cap'], batch, template.get('others'))}
    v: dict = {}
    context['v'] = v
    for name, value in template.get('values', {}).items():
        v[name] = evaluate(value, context)

    found: list[tuple[str, str, str]] = []
    line_rows, over = [], []
    total_words = total_budget = 0
    rule = settings['over_budget']
    for line in template['lines']:
        text = evaluate(line['text'], context)
        w, b = count(text), line['budget']
        total_words += w
        total_budget += b
        d = w - b
        line_rows.append(f"| {line['no']} | {line['slot']} | {escape_cell(render(text))} | {b} | {w} | "
                         f"{'+' if d > 0 else ''}{d} |  {line['secs']} |")
        found += [(f"line {line['no']}",) + h for h in holes(text)]
        if b and w > b * rule['ratio'] and w - b >= rule['min_words']:
            over.append(f"L{line['no']}")
    extra = evaluate(template.get('extra'), context)
    if extra:
        found += [("note",) + h for h in holes(extra)]
    slot_rows = []
    for slot in template['slots']:
        picture = evaluate(slot['picture'], context)
        slot_rows.append(f"| {slot['slot']} | {slot['time']} | {slot['line']} | {escape_cell(render(picture))} | {slot['made']} |")
        found += [(f"slot {slot['slot']}",) + h for h in holes(picture)]
    shoot = [f"- {render(evaluate(s, context))}" for s in template['shoot']]
    reuse = [f"- {evaluate(s, context)}" for s in template['reuse']]

    seen, hole_rows = set(), []
    for where, label, what in found:
        if (where, label) in seen:
            continue
        seen.add((where, label))
        hole_rows.append(f"| [{escape_cell(label)}] | {where} | {escape_cell(what)} |")
    standard = [evaluate(row, context) for row in settings.get('standard_holes', [])]
    hole_rows += standard

    pct = (total_words - total_budget) / total_budget * 100 if total_budget else 0
    context['fill'] = {'line_rows': line_rows, 'words': total_words, 'budget': total_budget, 'pct': signed(pct),
                       'over': ', '.join(over), 'extra': render(extra) if extra else None, 'slot_rows': slot_rows,
                       'shoot_items': shoot, 'reuse_items': reuse, 'hole_rows': hole_rows}
    return {'format': fmt['id'], 'capability': entry['cap']['key'], 'file': f"{fmt['id']}/{entry['cap']['key']}.md",
            'text': page(settings['fill_page'], context), 'words': total_words, 'budget': total_budget,
            'holes': len(seen) + len(standard)}


def index(request: dict, batch: list[dict], fills: list[dict]) -> str:
    """The page over every fill: the person's words, with each format, capability, fill and bucket put in."""
    spec = request['index']
    by = {(f['format'], f['capability']): f for f in fills}
    formats = request['formats']
    rows = []
    for entry in batch:
        cells = [fill_text(spec['matrix']['cell'], {**entry, 'fill': by[(fmt['id'], entry['cap']['key'])]}) for fmt in formats]
        rows.append(f"| {fill_text(spec['matrix']['row'], entry)} | " + " | ".join(cells) + " |")
    counts = spec.get('counts', {})
    buckets = [{**b, 'count': b['count'] if 'count' in b else counts.get(b['count_from'], 0)} for b in spec.get('buckets', [])]
    context = {'settings': request['settings'], 'formats': formats, 'capabilities': batch, 'buckets': buckets,
               'index': {'matrix_header': "| capability | " + " | ".join(fill_text(spec['matrix']['column'], {'format': f})
                                                                       for f in formats) + " |",
                         'matrix_rule': "|---|" + "---|" * len(formats), 'matrix_rows': rows,
                         'bucket_total': sum(b['count'] for b in buckets)}}
    return page(spec['page'], context)


def check(request: dict) -> list[str]:
    """What is missing or wrong in a request, as sentences saying what to give (empty when it can be filled)."""
    problems = []
    for key in ('settings', 'formats', 'capabilities', 'listings'):
        if key not in request:
            problems.append(f'The request has no "{key}"; see the README for its shape.')
    if problems:
        return problems
    for key in ('fill_page', 'over_budget'):
        if key not in request['settings']:
            problems.append(f'settings has no "{key}".')
    for fmt in request['formats']:
        t = fmt.get('template', {})
        for key in ('lines', 'slots', 'shoot', 'reuse'):
            if key not in t:
                problems.append(f'Format {fmt.get("id")} template has no "{key}".')
        if t.get('count', 'words') not in COUNTERS:
            problems.append(f'Format {fmt.get("id")} count is {t.get("count")!r}; use one of {", ".join(COUNTERS)}.')
    for cap in request['capabilities']:
        if cap.get('id') not in request['listings']:
            problems.append(f'Capability {cap.get("key")} names listing {cap.get("id")!r}, which the request\'s listings lack.')
    return problems


def fill_all(request: dict) -> dict:
    problems = check(request)
    if problems:
        raise TemplateError(' '.join(problems))
    batch = [{'cap': c, 'listing': request['listings'][c['id']]['listing'], 'listing_file': request['listings'][c['id']]['file']}
             for c in request['capabilities']]
    fills = [fill(fmt, entry, batch, request['settings']) for fmt in request['formats'] for entry in batch]
    answer = {'fills': fills, 'count': len(fills)}
    if request.get('index'):
        answer['index'] = {'file': request['index'].get('file', 'INDEX.md'), 'text': index(request, batch, fills)}
    return answer
