"""Templates and requests as DATA: one refusal type, the request binder and the template filler.

A request may name its files relative to the request file, or to this Workshop checkout:
  {"here": "plans/a.json"}                   that file, from the request's folder (symbolic links are kept, so a virtual
                                             environment's python stays itself)
  {"workshop": "tools/x/do-work/y.py"}       that file, from the root of the Workshop checkout this tool runs from
  {"repository": "tools/checker"}            that file, from the root of the git repository holding the request file
  {"read_json": <path, {"here": ...} or {"workshop": ...}>, "at": [k, ...]}
                                             the JSON value at that key path of that file (the whole file without "at"),
                                             so a number another tool owns is read from its owner, never copied
  "extends": <a request>                     (top level) that request with this one laid over it key by key

A template is any JSON value a renderer or checker reads. Inside it:
  {"fill": "<name>"}                       the value the tool measured under that name
  {"by_side": {"left": v, "right": v}}     v for the side of the frame the graphic sits on
  {"join": [part, ...]}                    the parts filled, as one text
  {"each": "<name>"}  as a list item       the items of the list of that name, spliced into the list
  "<key>": {"if": "<name>", "then": v}     the key only when the value of that name is present and not empty
  "on_side": {"left": {...}, "right": {...}}   keys that only the graphic on that side has, laid into the object
  "why": ...                               a note for people, at any depth: never filled into what the tool writes
"""
import json
import os
from pathlib import Path


class Refused(Exception):
    """A request the tool cannot do as asked. The message says what is wrong and what to change."""


def value(values, name):
    if name not in values:
        raise Refused(f'a template names "{name}", which the tool does not measure here; it measures: {", ".join(sorted(values))}')
    return values[name]


def _empty(v):
    return v is None or v == '' or v == [] or v == {}


def fill(template, values, side=None):
    """the template with every fill, by_side, join, each, if and on_side replaced from values; why notes left out"""
    if isinstance(template, list):
        out = []
        for item in template:
            if isinstance(item, dict) and set(item) == {'each'}:
                out.extend(value(values, item['each']))
            else:
                out.append(fill(item, values, side))
        return out
    if not isinstance(template, dict):
        return template
    keys = set(template)
    if keys == {'fill'}:
        return value(values, template['fill'])
    if keys == {'by_side'}:
        if side not in template['by_side']:
            raise Refused(f'a by_side template has no value for the {side} side: give both "left" and "right"')
        return fill(template['by_side'][side], values, side)
    if keys == {'join'}:
        return ''.join(str(fill(part, values, side)) for part in template['join'])
    out = {}
    for k, v in template.items():
        if k == 'why':
            continue
        if k == 'on_side':
            if side not in v:
                raise Refused(f'an on_side template has no keys for the {side} side: give both "left" and "right"')
            out.update(fill(v[side], values, side))
            continue
        if isinstance(v, dict) and set(v) == {'if', 'then'}:
            if _empty(values.get(v['if'])):
                continue
            v = v['then']
        out[k] = fill(v, values, side)
    return out


def repository_of(base):
    """the root of the git repository holding the folder base: the nearest folder upward with a .git"""
    if base is None:
        raise Refused('the request names a file by {"repository": ...} but gives no folder: run with --request <file>, or set "relative_to"')
    for folder in (Path(base), *Path(base).parents):
        if (folder / '.git').exists():
            return str(folder)
    raise Refused(f'{base} is in no git repository, so {{"repository": ...}} has no root; use {{"here": ...}}')


def bind(doc, base, workshop):
    """the request with every {"here": ...} and {"workshop": ...} made absolute and every {"read_json": ...} read"""
    if isinstance(doc, list):
        return [bind(v, base, workshop) for v in doc]
    if not isinstance(doc, dict):
        return doc
    keys = set(doc)
    if keys == {'here'}:
        if base is None:
            raise Refused('the request names a file by {"here": ...} but gives no folder it is relative to: run with --request <file>, '
                          'or set "relative_to" to an absolute folder')
        return os.path.normpath(os.path.join(base, doc['here']))
    if keys == {'workshop'}:
        return os.path.normpath(os.path.join(workshop, doc['workshop']))
    if keys == {'repository'}:
        return os.path.normpath(os.path.join(repository_of(base), doc['repository']))
    if keys in ({'read_json'}, {'read_json', 'at'}):
        source = bind(doc['read_json'], base, workshop)
        try:
            found = json.loads(Path(source).read_text())
        except (OSError, ValueError) as e:
            raise Refused(f'read_json {source}: {e}') from e
        for k in doc.get('at', []):
            try:
                found = found[k]
            except (KeyError, IndexError, TypeError) as e:
                raise Refused(f'read_json {source} has no {doc["at"]}: stopped at {k!r}') from e
        return bind(found, str(Path(source).parent), workshop)
    return {k: bind(v, base, workshop) for k, v in doc.items()}


def merged(base, over):
    """base with over laid on it, key by key at every depth (a list or a value in over replaces base's)"""
    if not isinstance(base, dict) or not isinstance(over, dict):
        return over
    out = dict(base)
    for k, v in over.items():
        out[k] = merged(base.get(k), v) if k in base else v
    return out
