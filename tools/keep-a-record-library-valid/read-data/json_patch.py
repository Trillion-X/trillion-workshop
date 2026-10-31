"""Edit named members of one JSON object while keeping every other byte of the file.

`patch_object_members` rewrites only the values it is given (or adds members) in the object found by following `path` from the
document's root, in the file's own indentation, spacing and line endings, and proves the edit has an exact byte inverse.
"""
from __future__ import annotations

import json


def json_members(text, start):
    """Locate object values without reserializing neighbouring source bytes."""
    decoder = json.JSONDecoder()
    pos = start + 1
    members = {}
    while True:
        while text[pos].isspace():
            pos += 1
        if text[pos] == '}':
            return members, pos
        key_start = pos
        key, key_end = decoder.raw_decode(text, pos)
        if not isinstance(key, str) or key in members:
            raise ValueError('Evidence-only source objects need unique string keys')
        pos = key_end
        while text[pos].isspace():
            pos += 1
        if text[pos] != ':':
            raise ValueError('Invalid JSON object member')
        pos += 1
        while text[pos].isspace():
            pos += 1
        value_start = pos
        _, pos = decoder.raw_decode(text, pos)
        members[key] = (key_start, key_end, value_start, pos)
        while text[pos].isspace():
            pos += 1
        if text[pos] == '}':
            return members, pos
        if text[pos] != ',':
            raise ValueError('Invalid JSON object separator')
        pos += 1


def patch_object_members(source_bytes, path, updates):
    """Change named values/add members; retain all other original UTF-8 bytes."""
    text = source_bytes.decode('utf-8')
    start = len(text) - len(text.lstrip())
    for key in path:
        if text[start] != '{':
            raise ValueError('Evidence target must be an object')
        members, _ = json_members(text, start)
        if key not in members:
            raise ValueError(f'Missing evidence source member: {key}')
        start = members[key][2]
    if text[start] != '{':
        raise ValueError('Evidence target must be an object')
    members, close = json_members(text, start)
    raw = text[start:close + 1]
    newline = '\r\n' if '\r\n' in raw else '\n'
    multiline = '\n' in raw
    line_indent = lambda pos: text[text.rfind('\n', 0, pos) + 1:pos]
    if multiline:
        key_indent = line_indent(next(iter(members.values()))[0]) if members else line_indent(close) + ' '
        parent_indent = line_indent(close)
        unit = key_indent[len(parent_indent):] if key_indent.startswith(parent_indent) else ' '
        if not unit or not unit.isspace() or not key_indent.isspace():
            raise ValueError('Cannot preserve the evidence object indentation')
        colon = ': '
        joiner = ',' + newline + key_indent
    else:
        key_indent, unit = '', None
        first = next(iter(members.values()), None)
        colon = text[first[1]:first[2]] if first else ': '
        joiner = ', ' if ', ' in raw else ','
    def encode(value):
        value_text = json.dumps(value, ensure_ascii=False, indent=unit,
                               separators=None if multiline else (joiner, colon))
        return value_text.replace('\n', newline + key_indent) if multiline else value_text
    edits, additions = [], []
    for key, value in updates.items():
        if key in members:
            _, _, a, b = members[key]
            edits.append((a, b, encode(value)))
        else:
            additions.append(json.dumps(key, ensure_ascii=False) + colon + encode(value))
    if additions:
        insert_at = close
        while insert_at > start + 1 and text[insert_at - 1].isspace():
            insert_at -= 1
        prefix = (',' if members else '') + (newline + key_indent if multiline else '')
        edits.append((insert_at, insert_at, prefix + joiner.join(additions)))
    result = text
    for a, b, value in sorted(edits, reverse=True):
        result = result[:a] + value + result[b:]
    inverse, shift = [], 0
    for a, b, value in sorted(edits):
        inverse.append((a + shift, a + shift + len(value), text[a:b]))
        shift += len(value) - (b - a)
    restored = result
    for a, b, value in sorted(inverse, reverse=True):
        restored = restored[:a] + value + restored[b:]
    if restored.encode('utf-8') != source_bytes:
        raise ValueError('Evidence source edit does not have an exact byte inverse')
    return result.encode('utf-8')

