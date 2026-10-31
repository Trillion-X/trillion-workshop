"""A piece and its items: the header tags routes are tested against, the files each item is judged on, the BLAKE3 pins of those files, and the
flags an item's own files prove.

A piece is a folder. Its header is a fenced block of `key: value` lines under a heading in one file of it; the schema names the file, the heading and
which keys hold tags. An item is one thing the checklist is answered for (a cut, a page, a take): the piece's globs find its files, and its id is
the file's stem (or, when the piece says so, its path under the piece without extension).
"""
from __future__ import annotations

import glob
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from gate_library import Library, dotted_get, file_blake3, natural_key, read_json, values_at


# --------------------------------------------------------------------------- header and routes

def parse_header(header_file: Path, heading: str) -> dict[str, str]:
    """The `key: value` lines of the fenced block under the heading of a markdown file."""
    if not header_file.is_file():
        return {}
    text = header_file.read_text(encoding='utf-8')
    m = re.search(r'^##[^\n]*' + re.escape(heading) + r'[^\n]*\n+```[^\n]*\n(.*?)\n```', text, re.M | re.S)
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
    for field in cfg['tag_fields']:
        value = re.sub(r'\([^)]*\)', ' ', header.get(field, ''))
        tags |= {t for t in re.split(r'[\s,|]+', value) if re.fullmatch(r'[a-z0-9:+-]+', t)}
    for tag, implied in cfg['implied_tags'].items():
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


# --------------------------------------------------------------------------- the piece's own settings

def piece_config(lib: Library, piece: Path) -> dict:
    """The piece's own config file; a piece directly under the schema's defaults folder with none gets the defaults; any other piece gets {}."""
    piece = piece.expanduser().resolve()
    spec = lib.section('piece')['config']
    own = piece / spec['file']
    if own.is_file():
        return read_json(own)
    if spec.get('defaults_when_parent') and piece.parent == (lib.root / spec['defaults_when_parent']).resolve():
        return spec['defaults']
    return {}


def config_value(lib: Library, piece: Path, key: str, default: Any = None) -> Any:
    """A setting of the piece's config, found at the dotted path the schema names for it (`piece.config.keys`)."""
    path = lib.section('piece')['config']['keys'].get(key)
    return default if path is None else dotted_get(piece_config(lib, piece), path, default)


def item_globs(lib: Library, piece: Path) -> list[str]:
    return config_value(lib, piece, 'item_globs', [])


def item_id(lib: Library, piece: Path, file: Path) -> str:
    """An item's id: its file name without extension, or, when the piece's id mode is "path" (files that share a name across folders), its path under the piece without extension."""
    if config_value(lib, piece, 'id_mode') == 'path':
        return str(Path(os.path.realpath(file)).relative_to(piece.expanduser().resolve()).with_suffix(''))
    return file.stem


def piece_files(lib: Library, piece: Path) -> list[Path]:
    """Every file the piece offers as an item: what its globs match, except under folders the schema says are not deliverables (work folders, held-back folders, watch folders)."""
    root = piece.expanduser().resolve()
    skip = re.compile(lib.section('items')['not_items_pattern'])
    found = {Path(f) for g in item_globs(lib, root) for f in glob.glob(str(root / g))}
    return sorted(f for f in found if f.is_file() and not skip.search(str(f.relative_to(root).parent)))


def offered_paths(lib: Library, piece: Path) -> set[str] | None:
    """Real paths of the piece's offered files; None when the piece declares none."""
    if not item_globs(lib, piece):
        return None
    return {os.path.realpath(f) for f in piece_files(lib, piece)}


def item_files(lib: Library, piece: Path, options: list[str] | None) -> dict[str, list[Path]]:
    """{item: its files} for these items (all when None); compilations (files that stand for every item in their folder) excluded."""
    piece = piece.expanduser().resolve()
    compilation = re.compile(lib.section('items')['compilation_pattern'])
    wanted = None if options is None else set(options)
    out: dict[str, list[Path]] = {}
    for f in piece_files(lib, piece):
        o = item_id(lib, piece, f)
        if not compilation.search(f.stem) and (wanted is None or o in wanted):
            out.setdefault(o, []).append(f)
    return out


def all_items(lib: Library, piece: Path) -> list[str]:
    return sorted(item_files(lib, piece, None))


def lane_spec(lib: Library, piece: Path, lane: Path, name: str) -> Path | None:
    """An item's spec in its lane: the newest match of the first spec glob that matches (the piece's own, else the schema's), each relative to the lane, {name} the item's file name; newest is by round number, so round 10 follows round 9."""
    globs = config_value(lib, piece, 'spec_globs') or lib.section('items')['spec_globs']
    for pattern in globs:
        found = sorted(lane.glob(pattern.format(name=name)), key=natural_key)
        if found:
            return found[-1]
    return None


# --------------------------------------------------------------------------- file pins

def file_pins(lib: Library, piece: Path, files: dict[str, list[Path]]) -> dict[str, str]:
    """{item: BLAKE3 of its files' bytes} (several files joined by '+'). Hashes are kept in a cache under the schema's file_pin_cache (one JSON file per piece,
    named by its absolute path), keyed by path, size and change time, so an unchanged file is read once; the pin itself is always the bytes' BLAKE3."""
    folder = lib.path_of(lib.section('items')['file_pin_cache'])
    folder.mkdir(parents=True, exist_ok=True)
    cache_path = folder / (str(piece.expanduser().resolve()).strip('/').replace('/', '__') + '.pins')
    cache = read_json(cache_path) if cache_path.is_file() else {}
    pins, dirty = {}, False
    for option, paths in files.items():
        parts = []
        for f in sorted(paths):
            st, key = f.stat(), str(f)
            hit = cache.get(key)
            if not hit or (hit['bytes'], hit['mtime_ns']) != (st.st_size, st.st_mtime_ns):
                hit = cache[key] = {'bytes': st.st_size, 'mtime_ns': st.st_mtime_ns, 'blake3': file_blake3(f)}
                dirty = True
            parts.append(hit['blake3'])
        pins[option] = '+'.join(parts)
    if dirty:
        with tempfile.NamedTemporaryFile('w', dir=cache_path.parent, prefix=cache_path.name, suffix='.tmp', delete=False, encoding='utf-8') as tmp:
            json.dump(cache, tmp, indent=1)
        os.replace(tmp.name, cache_path)
    return pins


# --------------------------------------------------------------------------- flags the files prove, and routing

def proven_tags(lib: Library, piece: Path, files: dict[str, list[Path]]) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """({item: the flags its own files prove}, {item: the flags not yet known}), by the schema's proven_flags. A `spec` flag holds when any of its paths has a
    value in the item's spec. A `report` flag reads one check's findings in the item's newest checker report not older than the file (the schema's
    report_globs): it holds when the check ran and no finding has a value at absent_when, for files with one of its suffixes. With no such report the
    flag is unknown, which routes its rows as open, never as absent. The header can add flags, never remove one its files prove."""
    items = lib.section('items')
    rules, globs = items['proven_flags'], items['report_globs']
    proven: dict[str, set[str]] = {}
    unknown: dict[str, set[str]] = {}
    for option, paths in files.items():
        docs = [read_json(spec) for f in paths for spec in [lane_spec(lib, piece, lane_of(lib, f), f.stem)] if spec]
        proven[option], unknown[option] = set(), set()
        for r in rules:
            if r['source'] == 'spec':
                if any(values_at(doc, path) for doc in docs for path in r['paths']):
                    proven[option].add(r['flag'])
                continue
            judged = [f for f in paths if f.suffix.lower().lstrip('.') in r['suffixes']]      # files the check can judge; a sound file has nothing for a picture check to find
            if not judged:
                continue
            findings = None
            for f in judged:
                reports = sorted({g for pattern in globs for g in lane_of(lib, f).glob(pattern.format(folder=f.parent.name, name=f.stem))},
                                 key=lambda g: g.stat().st_mtime, reverse=True)
                for report in reports:
                    if report.stat().st_mtime < f.stat().st_mtime:
                        break      # older than the file: it judged other bytes
                    entry = next((v for k, v in read_json(report).items() if not k.startswith('_') and Path(k).stem == f.stem and isinstance(v, dict)), None)
                    if entry is not None and r['check'] in entry:
                        findings = entry[r['check']]
                        break
            if findings is None:
                unknown[option].add(r['flag'])
            elif findings and not any(values_at(x, r['absent_when']) for x in findings):
                proven[option].add(r['flag'])
    return proven, unknown


def lane_of(lib: Library, file: Path) -> Path:
    """The folder an item's file belongs to (its lane): the schema's lane_up levels above the file."""
    return file.parents[lib.section('items')['lane_up'] - 1]


def file_scoped_tags(lib: Library, piece: Path, header: dict[str, str], tags: set[str], options: list[str]) -> tuple[set[str], dict[str, set[str]]]:
    """(piece-level tags, {item: its tags}). A medium in the schema's file_media applies per file: an item whose file has one of its suffixes takes that
    medium alone (with the header's other tags). When the header also names another medium, the other files and the piece-level rows drop it, so a piece
    of picture items and sound items routes picture rows to the pictures and sound rows to the sounds."""
    scoped = {m: set(s) for m, s in lib.section('items').get('file_media', {}).items()}
    media = header_tags({'medium': header.get('medium', '')}, lib.piece_header)
    named = {m for m in scoped if m in media}
    if not named:
        return tags, {o: tags for o in options}
    others = media - named
    piece_tags = tags - named if others else tags
    suffix = {item_id(lib, piece, p): p.suffix.lower().lstrip('.') for p in piece_files(lib, piece)} if options else {}

    def tags_of(option: str) -> set[str]:
        medium = next((m for m in sorted(named) if suffix.get(option) in scoped[m]), None)
        return (tags - media) | {medium} if medium else piece_tags
    return piece_tags, {o: tags_of(o) for o in options}


def routing(lib: Library, piece: Path, options: list[str]):
    """(piece-level tags, {item: its tags}, routed(check) -> the items a check routes to, {item: flags not yet known}): the header's tags, per-file
    media and the flags each item's files prove or cannot yet rule out, joined. gate and record_answer both route through this."""
    piece = piece.expanduser().resolve()
    header = parse_header(piece / lib.piece_header['file'], lib.piece_header['heading'])
    tags, option_tags = file_scoped_tags(lib, piece, header, header_tags(header, lib.piece_header), options)
    proven, unknown = proven_tags(lib, piece, item_files(lib, piece, options))
    option_tags = {o: option_tags[o] | proven.get(o, set()) | unknown.get(o, set()) for o in options}
    tags = tags.union(*proven.values(), *unknown.values())
    return tags, option_tags, lambda check: [o for o in options if route_applies(check['routes'], option_tags[o])], {o: sorted(u) for o, u in unknown.items() if u}
