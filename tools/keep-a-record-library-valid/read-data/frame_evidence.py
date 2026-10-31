"""Evidence made of video frames, kept by file identity.

Four jobs, none of which decodes or extracts media:
  * `normalize_manifest`: a frame manifest (`{ source: { path }, frames: [{ index, pts, seconds, path }] }`) read into records whose
    source and frame files each carry their BLAKE3 identity. The original manifest stays the receipt of the tool that wrote it:
    its own hash fields are never read, copied or required.
  * `build_pages` and `build_candidate_pair_pages`: already-extracted frames arranged into labelled review pages. A page proves
    nothing about review; its index says `generated_not_reviewed`.
  * `finalize_page_journal`: a manifest, an extraction readback and a person's page notes joined into one journal whose every
    file is pinned by identity.
  * `validate_page_journal`: the same joins re-checked against the bytes on disk now.

The words that name a person's own journal (its schema labels, the note field holding a frame's state) come in a `frame_evidence`
profile from the library's schema; none is in this file. Pages need Pillow; the rest needs only the standard library.
"""
from __future__ import annotations

import json
import math
from fractions import Fraction
from pathlib import Path
from typing import Any, Mapping, Sequence

from library import content_identity

PROFILE_KEYS = ('projection_schema', 'journal_schema', 'journal_final_status', 'observation_schema', 'readback_schema',
                'state_field', 'readback_hash_field', 'validation_scope')


def check_profile(profile: Mapping[str, Any] | None) -> Mapping[str, Any]:
    missing = [key for key in PROFILE_KEYS if not isinstance(profile, Mapping) or not isinstance(profile.get(key), str) or not profile[key]]
    if missing:
        raise ValueError(f'The schema\'s frame_evidence profile must name: {", ".join(missing)}')
    return profile


# ---------------------------------------------------------------------------- manifest projection

def _without_vendor_hashes(value: Any) -> Any:
    """Copy JSON data while leaving the writing tool's own digest fields in its file."""
    if isinstance(value, dict):
        def is_digest(key: str) -> bool:
            tokens = key.casefold().replace('-', '_').split('_')
            return any(token in {'sha', 'sha1', 'sha256', 'sha512', 'blake3', 'b3', 'hash', 'digest'} for token in tokens)

        return {key: _without_vendor_hashes(item) for key, item in value.items() if not is_digest(key)}
    if isinstance(value, list):
        return [_without_vendor_hashes(item) for item in value]
    return value


def resolve_record_path(value: Any, manifest_path: Path, field: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError(f'{field} must be a nonempty path')
    path = Path(value)
    if not path.is_absolute():
        path = manifest_path.parent / path
    path = path.resolve(strict=True)
    if not path.is_file():
        raise ValueError(f'{field} is not a regular file: {path}')
    return path


def _check_declared_bytes(record: dict, identity: dict, label: str) -> None:
    declared = record.get('bytes')
    if declared is not None and declared != identity['bytes']:
        raise ValueError(f'{label} byte count disagrees with the file: {declared} != {identity["bytes"]}')


def normalize_manifest(manifest_path: Path | str, projection_schema: str) -> dict[str, Any]:
    """Canonical source and frame records with a BLAKE3-pinned receipt.

    Frame order and the source-provided index, PTS and seconds values are kept exactly.
    """
    manifest_path = Path(manifest_path).expanduser().resolve(strict=True)
    if not manifest_path.is_file():
        raise ValueError(f'manifest is not a regular file: {manifest_path}')
    vendor = json.loads(manifest_path.read_text(encoding='utf-8'))
    if not isinstance(vendor, dict) or not isinstance(vendor.get('source'), dict):
        raise ValueError('expected a frame manifest with a source object')
    rows = vendor.get('frames')
    if not isinstance(rows, list) or not rows:
        raise ValueError('expected a nonempty frames list')

    source_record = vendor['source']
    source_path = resolve_record_path(source_record.get('path'), manifest_path, 'source.path')
    source_identity = content_identity(source_path)
    _check_declared_bytes(source_record, source_identity, 'source')
    source = _without_vendor_hashes(source_record)
    source['path'] = str(source_path)
    source['bytes'] = source_identity['bytes']
    source['identity'] = source_identity

    frames = []
    seen_indices = set()
    for position, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f'frames[{position}] must be an object')
        index, pts, seconds = row.get('index'), row.get('pts'), row.get('seconds')
        if type(index) is not int or type(pts) is not int or type(seconds) not in (int, float):
            raise ValueError(f'frames[{position}] must include integer index/PTS and numeric seconds')
        if index in seen_indices:
            raise ValueError(f'duplicate frame index: {index}')
        seen_indices.add(index)
        frame_path = resolve_record_path(row.get('path'), manifest_path, f'frames[{position}].path')
        identity = content_identity(frame_path)
        _check_declared_bytes(row, identity, f'frame {index}')
        frame = _without_vendor_hashes(row)
        frame['path'] = str(frame_path)
        frame['bytes'] = identity['bytes']
        frame['identity'] = identity
        frames.append(frame)

    return {
        'schema': projection_schema,
        'vendor_manifest': {'path': str(manifest_path), 'identity': content_identity(manifest_path)},
        'vendor_schema': vendor.get('schema'),
        'vendor_tool': _without_vendor_hashes(vendor.get('tool')),
        'kind': vendor.get('kind'),
        'source': source,
        'selection': _without_vendor_hashes(vendor.get('selection')),
        'frame_count': len(frames),
        'frames': frames,
    }


def write_projection(manifest: Path, output: Path, projection_schema: str) -> dict:
    projection = normalize_manifest(manifest, projection_schema)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x', encoding='utf-8') as stream:
        json.dump(projection, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    return {'output': str(output.resolve()), 'frame_count': projection['frame_count'],
            'source_identity': projection['source']['identity'], 'manifest_identity': projection['vendor_manifest']['identity']}


# ---------------------------------------------------------------------------- review pages

def _font(font_file: Path | None, size: int):
    from PIL import ImageFont
    return ImageFont.truetype(str(font_file), size) if font_file and font_file.exists() else ImageFont.load_default()


def build_pages(manifest: Path, output: Path, per_page: int = 48, tile_width: int = 256, quality: int = 40, font_file: Path | None = None) -> dict:
    from PIL import Image, ImageDraw
    if not 1 <= per_page <= 60:
        raise ValueError('per_page must be 1..60')
    if not 160 <= tile_width <= 384 or not 20 <= quality <= 90:
        raise ValueError('tile_width must be 160..384 and quality 20..90')
    manifest = manifest.resolve()
    data = json.loads(manifest.read_text())
    rows = sorted(data['frames'], key=lambda row: (float(row['seconds']), row['index']))
    if not rows or len({row['index'] for row in rows}) != len(rows):
        raise ValueError('Expected nonempty unique native frame indices')
    if any(float(b['seconds']) <= float(a['seconds']) for a, b in zip(rows, rows[1:])):
        raise ValueError('Native source seconds must increase strictly')
    # Manifest paths are usually absolute; relative paths resolve beside the manifest.
    paths = []
    for row in rows:
        path = Path(row['path'])
        path = path if path.is_absolute() else manifest.parent / path
        if not path.is_file():
            raise ValueError(f'Missing source evidence frame: {path}')
        paths.append(path)
    if output.exists() and any(output.iterdir()):
        raise ValueError(f'Refusing to overwrite existing review pages: {output}')
    output.mkdir(parents=True, exist_ok=True)
    font = _font(font_file, 12)
    pages = []
    width, height, label_height, columns = tile_width, round(tile_width * 9 / 16), 24, 6
    for start in range(0, len(rows), per_page):
        group = rows[start:start + per_page]
        sheet = Image.new('RGB', (columns * width, math.ceil(len(group) / columns) * (height + label_height)), '#16181d')
        draw = ImageDraw.Draw(sheet)
        for offset, row in enumerate(group):
            x, y = offset % columns * width, offset // columns * (height + label_height)
            with Image.open(paths[start + offset]) as image:
                preview = image.convert('RGB')
                preview.thumbnail((width, height))
                sheet.paste(preview, (x + (width - preview.width) // 2, y + label_height))
            draw.text((x + 3, y + 3), f'{row["seconds"]:.3f}s | f{row["index"]}', font=font, fill='white')
        page = output / f'page-{len(pages) + 1:03d}.jpg'
        sheet.save(page, quality=quality, optimize=True)
        pages.append({'path': str(page.resolve()), 'first_s': group[0]['seconds'], 'last_s': group[-1]['seconds'],
                      'native_indices': [row['index'] for row in group], 'identity': content_identity(page)})
    result = {'source_manifest': str(manifest), 'source_manifest_identity': content_identity(manifest),
              'source': data.get('source'), 'coverage': 'Existing sampled frames only; not continuous AV or proof of viewing',
              'preview': {'tile_width': width, 'max_tile_height': height, 'jpeg_quality': quality,
                          'note': 'Resized review previews; retain individual native-resolution evidence for detail'},
              'review_status': 'generated_not_reviewed', 'frame_count': len(rows), 'page_count': len(pages), 'pages': pages}
    (output / 'index.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def source_clock(source_metadata: Mapping[str, Any]) -> tuple[Fraction, int, float]:
    """The source's seconds clock from a manifest (`source.video`), a video object (`video`) or a `clock` object.

    An explicit time base is required; a frame rate is never guessed.
    """
    video: Mapping[str, Any] | None = None
    if isinstance(source_metadata.get('source'), Mapping):
        source = source_metadata['source']
        if isinstance(source.get('video'), Mapping):
            video = source['video']
    if video is None and isinstance(source_metadata.get('video'), Mapping):
        video = source_metadata['video']
    clock = source_metadata.get('clock')
    if video is None and isinstance(clock, Mapping):
        video = clock
    if video is None and 'time_base' in source_metadata:
        video = source_metadata
    if video is None or 'time_base' not in video:
        raise ValueError('Source metadata must provide video.time_base or clock.time_base')
    try:
        time_base = Fraction(str(video['time_base']))
    except (ValueError, ZeroDivisionError) as exc:
        raise ValueError(f'Invalid source time_base: {video.get("time_base")!r}') from exc
    if time_base <= 0:
        raise ValueError('Source time_base must be positive')
    first_pts = int(video.get('first_pts', video.get('pts_origin_ticks', 0)))
    origin_timestamp = float(video.get('origin_timestamp', 0.0))
    return time_base, first_pts, origin_timestamp


def build_candidate_pair_pages(pairs: Sequence[Mapping[str, Any]], source_metadata: Mapping[str, Any], output: Path, pairs_per_page: int = 6,
                               tile_width: int = 320, quality: int = 45, base_dir: Path | None = None, font_file: Path | None = None) -> dict:
    """Adjacent native frame pairs arranged for visual review.

    Each item has `before` and `after` frame records with `index`, `pts`, `seconds` and `path`. The after frame must be the
    immediately following native frame, and the source clock is required so a mislabeled PTS/time cannot be hidden by assuming
    a frame rate. Pages only show labelled source evidence; they do not classify cuts.
    """
    from PIL import Image, ImageDraw
    if not 1 <= pairs_per_page <= 6:
        raise ValueError('pairs_per_page must be 1..6')
    if not 160 <= tile_width <= 384 or not 20 <= quality <= 90:
        raise ValueError('tile_width must be 160..384 and quality 20..90')
    if not pairs:
        raise ValueError('Expected at least one native candidate pair')
    time_base, first_pts, origin_timestamp = source_clock(source_metadata)
    base_dir = (base_dir or Path.cwd()).resolve()
    normalized: list[dict[str, Any]] = []
    previous_after_seconds: float | None = None
    for pair_number, pair in enumerate(pairs, start=1):
        if not isinstance(pair, Mapping) or not isinstance(pair.get('before'), Mapping) or not isinstance(pair.get('after'), Mapping):
            raise ValueError(f'Pair {pair_number} must contain before and after frame records')
        frames: dict[str, Any] = {}
        for side in ('before', 'after'):
            frame = pair[side]
            for field in ('index', 'pts', 'seconds', 'path'):
                if field not in frame:
                    raise ValueError(f'Pair {pair_number} {side} frame is missing {field}')
            try:
                frames[side] = {'index': int(frame['index']), 'pts': int(frame['pts']), 'seconds': float(frame['seconds']),
                                'path': Path(frame['path'])}
            except (TypeError, ValueError) as exc:
                raise ValueError(f'Pair {pair_number} {side} frame has invalid native metadata') from exc
            if not math.isfinite(frames[side]['seconds']):
                raise ValueError(f'Pair {pair_number} {side} seconds must be finite')
            expected_seconds = float((frames[side]['pts'] - first_pts) * time_base) + origin_timestamp
            if abs(frames[side]['seconds'] - expected_seconds) > 1e-6:
                raise ValueError(f'Pair {pair_number} {side} seconds do not match source PTS/time_base '
                                 f'({frames[side]["seconds"]} != {expected_seconds})')
            path = frames[side]['path']
            path = path if path.is_absolute() else base_dir / path
            if not path.is_file():
                raise ValueError(f'Missing source evidence frame: {path}')
            frames[side]['path'] = path.resolve()
        before, after = frames['before'], frames['after']
        if after['index'] != before['index'] + 1:
            raise ValueError(f'Pair {pair_number} must contain adjacent native indices; got f{before["index"]}→f{after["index"]}')
        if after['seconds'] <= before['seconds']:
            raise ValueError(f'Pair {pair_number} timestamps must increase from before to after')
        if previous_after_seconds is not None and after['seconds'] <= previous_after_seconds:
            raise ValueError('Candidate pair timestamps must increase strictly in input order')
        previous_after_seconds = after['seconds']
        normalized.append(frames)

    if output.exists() and any(output.iterdir()):
        raise ValueError(f'Refusing to overwrite existing review pages: {output}')
    output.mkdir(parents=True, exist_ok=True)
    font = _font(font_file, 10)
    width, height, label_height = tile_width, round(tile_width * 9 / 16), 40
    columns, pairs_per_row = 4, 2
    pages: list[dict[str, Any]] = []
    for start in range(0, len(normalized), pairs_per_page):
        group = normalized[start:start + pairs_per_page]
        rows = math.ceil(len(group) / pairs_per_row)
        sheet = Image.new('RGB', (columns * width, rows * (height + label_height)), '#16181d')
        draw = ImageDraw.Draw(sheet)
        page_pairs = []
        for pair_offset, frames in enumerate(group):
            row_y = (pair_offset // pairs_per_row) * (height + label_height)
            pair_column = (pair_offset % pairs_per_row) * 2
            pair_details = {}
            for side_offset, side in enumerate(('before', 'after')):
                frame = frames[side]
                x = (pair_column + side_offset) * width
                with Image.open(frame['path']) as image:
                    preview = image.convert('RGB')
                    preview.thumbnail((width, height))
                    sheet.paste(preview, (x + (width - preview.width) // 2, row_y + label_height))
                label = f'{side.upper()} | f{frame["index"]}\nPTS {frame["pts"]}\n{frame["seconds"]:.6f}s'
                draw.multiline_text((x + 3, row_y + 2), label, font=font, fill='white', spacing=1)
                pair_details[side] = {key: frame[key] for key in ('index', 'pts', 'seconds')}
                pair_details[side]['path'] = str(frame['path'])
                pair_details[side]['identity'] = content_identity(frame['path'])
            page_pairs.append(pair_details)
        page = output / f'pair-page-{len(pages) + 1:03d}.jpg'
        sheet.save(page, quality=quality, optimize=True)
        pages.append({'path': str(page.resolve()), 'first_s': group[0]['before']['seconds'],
                      'last_s': group[-1]['after']['seconds'], 'pairs': page_pairs, 'identity': content_identity(page)})
    result = {
        'source': source_metadata.get('source', source_metadata.get('source_path')),
        'source_metadata': source_metadata,
        'coverage': 'Selected native candidate pairs only; generated evidence page, not a cut classification or proof of viewing',
        'preview': {'tile_width': width, 'max_tile_height': height, 'jpeg_quality': quality,
                    'note': 'Before/after native frames are adjacent in each pair row; retain original frames for detail'},
        'review_status': 'generated_not_reviewed',
        'pair_count': len(normalized),
        'page_count': len(pages),
        'pairs_per_page_max': pairs_per_page,
        'pages': pages,
    }
    (output / 'index.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def _frame_record(frame: Mapping[str, Any]) -> dict[str, Any]:
    """Either spelling of a candidate manifest's frame fields."""
    return {
        'index': frame.get('index', frame.get('native_frame')),
        'pts': frame.get('pts', frame.get('pts_ticks', frame.get('source_pts'))),
        'seconds': frame.get('seconds', frame.get('source_time_s')),
        'path': frame.get('path', frame.get('image_path')),
    }


def build_candidate_pair_pages_from_manifest(manifest: Path, output: Path, pairs_per_page: int = 6, tile_width: int = 320, quality: int = 45,
                                             font_file: Path | None = None) -> dict:
    """Pair pages from either candidate manifest shape: `frames` plus `change_candidates`, or `records` (`before` + `candidate` rows)."""
    manifest = manifest.resolve()
    data = json.loads(manifest.read_text())
    pairs: list[dict[str, Any]] = []
    if isinstance(data.get('frames'), list) and isinstance(data.get('change_candidates'), list):
        frames = {int(frame['index']): frame for frame in data['frames']}
        for event in data['change_candidates']:
            after_index = int(event['index'])
            try:
                before, after = frames[after_index - 1], frames[after_index]
            except KeyError as exc:
                raise ValueError(f'Candidate f{after_index} is missing its adjacent retained source frame') from exc
            pairs.append({'before': _frame_record(before), 'after': _frame_record(after)})
    elif isinstance(data.get('records'), list):
        grouped: dict[int, dict[str, Mapping[str, Any]]] = {}
        for row in data['records']:
            candidate_index = int(row['candidate_frame'])
            relation = str(row.get('relation', '')).lower()
            # The three-frame evidence format stores before, candidate and after. The candidate is the transition's incoming
            # frame; the final `after` record is context and is not part of the pair.
            side = 'before' if relation == 'before' else relation if relation in ('candidate', 'after') else None
            if side is None:
                continue
            if side in grouped.setdefault(candidate_index, {}):
                raise ValueError(f'Candidate f{candidate_index} has duplicate {side} source frames')
            grouped[candidate_index][side] = {'index': row['native_frame'], 'pts': row['pts_ticks'],
                                              'seconds': row['source_time_s'], 'path': row['image_path']}
        for candidate_index, group in grouped.items():
            incoming = group.get('candidate', group.get('after'))
            if 'before' not in group or incoming is None:
                raise ValueError(f'Candidate f{candidate_index} needs one before and one candidate/after frame')
            pairs.append({'before': group['before'], 'after': incoming})
    else:
        raise ValueError('Manifest must contain frames/change_candidates or native candidate records')
    if not pairs:
        raise ValueError('Manifest contains no complete native candidate pairs')
    result = build_candidate_pair_pages(pairs, source_metadata=data, output=output, pairs_per_page=pairs_per_page,
                                        tile_width=tile_width, quality=quality, base_dir=manifest.parent, font_file=font_file)
    result['source_manifest'] = str(manifest)
    result['source_manifest_identity'] = content_identity(manifest)
    (output / 'index.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


# ---------------------------------------------------------------------------- page journals

def _json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError(f'Expected JSON object: {path}')
    return value


def _resolved_ref(raw: str, owner: Path, label: str) -> Path:
    if not isinstance(raw, str) or not raw:
        raise ValueError(f'{label} must be a nonempty path')
    path = Path(raw)
    return (path if path.is_absolute() else owner.parent / path).resolve(strict=True)


def _pinned(path: Path) -> dict:
    return {'path': str(path.resolve()), 'identity': content_identity(path)}


def validate_page_journal(journal_path: Path, profile: Mapping[str, Any]) -> dict:
    """Recheck a finalized page journal and every file identity it pins.

    This confirms structural joins and current bytes. It does not judge whether the authored observations are visually correct
    or establish full audiovisual review.
    """
    profile = check_profile(profile)
    state_field, hash_field = profile['state_field'], profile['readback_hash_field']
    journal_path = journal_path.resolve(strict=True)
    journal = _json(journal_path)
    if journal.get('schema') != profile['journal_schema']:
        raise ValueError(f'Unsupported page journal schema: {journal.get("schema")!r}')
    if journal.get('status') != profile['journal_final_status']:
        raise ValueError('Page journal is not in final status')
    if not isinstance(journal.get('pages'), list) or not journal['pages']:
        raise ValueError('Page journal requires finalized pages')

    def verify_pin(pin: dict, label: str) -> Path:
        if not isinstance(pin, dict) or not isinstance(pin.get('path'), str):
            raise ValueError(f'Missing {label} pin')
        path = _resolved_ref(pin['path'], journal_path, label)
        if content_identity(path) != pin.get('identity'):
            raise ValueError(f'Stale {label} identity: {path}')
        return path

    manifest_path = verify_pin(journal.get('source_manifest'), 'source manifest')
    projection = normalize_manifest(manifest_path, profile['projection_schema'])
    if journal.get('source_identity') != projection['source']['identity']:
        raise ValueError('Page journal source identity is stale')
    frame_by_index = {row['index']: row for row in projection['frames']}
    extraction_path = verify_pin(journal.get('extraction_readback'), 'extraction readback')
    extraction = _json(extraction_path)
    source_pin = extraction.get('source') or {}
    source_identity = projection['source']['identity']
    if (source_pin.get('bytes') != source_identity['bytes'] or
            source_pin.get('blake3_before') != source_identity['value'] or
            source_pin.get('blake3_after') != source_identity['value']):
        raise ValueError('Extraction readback source identity disagrees with current source bytes')
    extraction_by_index = {row.get('index'): row for row in extraction.get('frames', [])}
    if len(extraction_by_index) != len(extraction.get('frames', [])):
        raise ValueError('Extraction readback contains duplicate frame indices')
    seen = set()
    for expected_page, page in enumerate(journal['pages'], start=1):
        if not isinstance(page, dict) or page.get('page') != expected_page:
            raise ValueError('Page journal pages must be ordered and uniquely numbered')
        observation_path = verify_pin(page.get('observation'), f'page {expected_page} observation')
        readback_path = verify_pin(page.get('readback'), f'page {expected_page} readback')
        observation, readback = _json(observation_path), _json(readback_path)
        contact_path = verify_pin(page.get('contact_sheet'), f'page {expected_page} contact sheet')
        contact_obs = _resolved_ref(observation.get('contact_sheet'), observation_path, 'observation.contact_sheet')
        contact_rb = _resolved_ref(readback.get('contact_sheet'), readback_path, 'readback.contact_sheet')
        contact_identity = content_identity(contact_path)
        if contact_obs != contact_path or contact_rb != contact_path:
            raise ValueError(f'Page {expected_page} contact sheet does not join to its notes')
        if (observation.get('page') != expected_page or readback.get('page') != expected_page or
                observation.get('contact_sheet_blake3') != contact_identity['value'] or
                readback.get('contact_sheet_blake3') != contact_identity['value'] or
                readback.get('contact_sheet_bytes') != contact_identity['bytes']):
            raise ValueError(f'Page {expected_page} note/readback contact identity is stale')
        if observation.get('readback') and _resolved_ref(observation['readback'], observation_path, 'observation.readback') != readback_path:
            raise ValueError(f'Page {expected_page} observation does not point to its paired readback')
        if readback.get('frame_observation_path') and _resolved_ref(readback['frame_observation_path'], readback_path, 'readback.frame_observation_path') != observation_path:
            raise ValueError(f'Page {expected_page} readback does not point to its paired observation')
        if readback.get('frame_observation_blake3') != content_identity(observation_path)['value']:
            raise ValueError(f'Page {expected_page} observation BLAKE3 is stale')
        obs_rows, rb_rows = observation.get('frames'), readback.get('frames')
        if not isinstance(obs_rows, list) or not isinstance(rb_rows, list):
            raise ValueError(f'Page {expected_page} note/readback frame rows are missing')
        obs_by_index = {row.get('index'): row for row in obs_rows}
        rb_by_index = {row.get('index'): row for row in rb_rows}
        if (len(obs_by_index) != len(obs_rows) or len(rb_by_index) != len(rb_rows) or
                set(obs_by_index) != set(rb_by_index)):
            raise ValueError(f'Page {expected_page} note/readback frame joins are duplicate or incomplete')
        if not isinstance(page.get('frames'), list) or set(row.get('index') for row in page['frames']) != set(obs_by_index):
            raise ValueError(f'Page {expected_page} aggregate frame rows differ from its notes')
        for item in page['frames']:
            index = item.get('index')
            if index in seen or index not in frame_by_index:
                raise ValueError(f'Duplicate or undeclared frame join: {index!r}')
            seen.add(index)
            source = frame_by_index[index]
            note, rb = obs_by_index[index], rb_by_index[index]
            frame_path = Path(source['path'])
            if (Path(item.get('path', '')).resolve() != frame_path or
                    _resolved_ref(note.get('path'), observation_path, f'frame {index} observation path') != frame_path or
                    _resolved_ref(rb.get('path'), readback_path, f'frame {index} readback path') != frame_path):
                raise ValueError(f'Page frame {index} path does not join to the source manifest')
            if item.get('identity') != source['identity']:
                raise ValueError(f'Page frame {index} identity does not join to the source manifest')
            if (item.get('pts') != source['pts'] or note.get('pts') != source['pts'] or rb.get('pts') != source['pts'] or
                    item.get('seconds') != source['seconds'] or note.get('seconds') != source['seconds'] or rb.get('seconds') != source['seconds']):
                raise ValueError(f'Page frame {index} PTS/time does not join to the source manifest')
            if (item.get('visual_observation') != note.get('visual_observation') or
                    item.get(state_field) != note.get(state_field)):
                raise ValueError(f'Page frame {index} aggregate note differs from its observation file')
            if (note.get('blake3') != source['identity']['value'] or
                    rb.get(hash_field) != source['identity']['value'] or
                    rb.get('bytes') != source['identity']['bytes']):
                raise ValueError(f'Page frame {index} note/readback identity is stale')
            extraction_frame = extraction_by_index.get(index)
            if (not extraction_frame or extraction_frame.get('blake3') != source['identity']['value'] or
                    extraction_frame.get('bytes') != source['identity']['bytes']):
                raise ValueError(f'Extraction readback frame {index} identity is missing or stale')
    if seen != set(frame_by_index):
        missing = sorted(set(frame_by_index) - seen)
        raise ValueError(f'Page journal is missing source frames: {missing[:8]}')
    return {'status': 'valid', 'page_count': len(journal['pages']),
            'frame_count': len(seen), 'scope': journal.get('validation_scope')}


def finalize_page_journal(manifest_path: Path, extraction_readback_path: Path, observation_paths: Sequence[Path],
                          readback_paths: Sequence[Path], output_path: Path, profile: Mapping[str, Any]) -> dict:
    """Join a frame manifest, authored page observations and readbacks into a new journal.

    Writes the aggregate file exclusively. Inputs and existing receipts are read only; no image decoding or extraction happens.
    """
    profile = check_profile(profile)
    state_field, hash_field = profile['state_field'], profile['readback_hash_field']
    manifest_path = manifest_path.resolve(strict=True)
    extraction_readback_path = extraction_readback_path.resolve(strict=True)
    observations = [path.resolve(strict=True) for path in observation_paths]
    readbacks = [path.resolve(strict=True) for path in readback_paths]
    output_path = output_path.resolve()
    if output_path.exists():
        raise ValueError(f'Refusing to overwrite page journal: {output_path}')
    if not observations or len(observations) != len(readbacks):
        raise ValueError('Provide equally sized nonempty observation and readback page lists')
    projection = normalize_manifest(manifest_path, profile['projection_schema'])
    source_meta = projection['source'].get('video') or {}
    try:
        time_base = Fraction(str(source_meta['time_base']))
        first_pts = int(source_meta.get('first_pts', 0))
        origin = float(source_meta.get('origin_timestamp', 0.0))
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        raise ValueError('Manifest source must declare a valid video time_base') from exc
    if time_base <= 0:
        raise ValueError('Manifest time_base must be positive')

    extraction = _json(extraction_readback_path)
    source_pin = extraction.get('source') or {}
    if source_pin.get('bytes') != projection['source']['identity']['bytes']:
        raise ValueError('Extraction readback source byte count disagrees with source manifest')
    expected_source_hash = projection['source']['identity']['value']
    if source_pin.get('blake3_after') != expected_source_hash or source_pin.get('blake3_before') != expected_source_hash:
        raise ValueError('Extraction readback source BLAKE3 disagrees with current source bytes')
    extraction_frames = extraction.get('frames')
    if not isinstance(extraction_frames, list):
        raise ValueError('Extraction readback must list native frames')
    extraction_by_index = {}
    for frame in extraction_frames:
        index = frame.get('index')
        if index in extraction_by_index:
            raise ValueError(f'Duplicate extraction readback frame: {index}')
        extraction_by_index[index] = frame

    manifest_by_index = {row['index']: row for row in projection['frames']}
    pages = []
    seen = set()
    for page_number, (observation_path, readback_path) in enumerate(zip(observations, readbacks), start=1):
        observation, readback = _json(observation_path), _json(readback_path)
        if observation.get('schema') != profile['observation_schema'] or readback.get('schema') != profile['readback_schema']:
            raise ValueError(f'Page {page_number} has an unsupported observation/readback schema')
        if observation.get('page') != page_number or readback.get('page') != page_number:
            raise ValueError(f'Page {page_number} is missing, duplicated, or out of order')
        if observation.get('readback') and _resolved_ref(observation['readback'], observation_path, 'observation.readback') != readback_path:
            raise ValueError(f'Page {page_number} observation does not point to its paired readback')
        note_path = readback.get('frame_observation_path')
        if note_path and _resolved_ref(note_path, readback_path, 'readback.frame_observation_path') != observation_path:
            raise ValueError(f'Page {page_number} readback does not point to its paired observation')
        note_status = str(readback.get('frame_observations', '')).casefold()
        if not note_status or 'pending' in note_status or 'reviewed' not in note_status:
            raise ValueError(f'Page {page_number} frame observation readback is not final')
        contact_obs = _resolved_ref(observation.get('contact_sheet'), observation_path, 'observation.contact_sheet')
        contact_rb = _resolved_ref(readback.get('contact_sheet'), readback_path, 'readback.contact_sheet')
        if contact_obs != contact_rb:
            raise ValueError(f'Page {page_number} contact-sheet paths disagree')
        contact_identity = content_identity(contact_obs)
        if observation.get('contact_sheet_blake3') != contact_identity['value'] or readback.get('contact_sheet_blake3') != contact_identity['value']:
            raise ValueError(f'Page {page_number} contact-sheet BLAKE3 is stale')
        if readback.get('contact_sheet_bytes') != contact_identity['bytes']:
            raise ValueError(f'Page {page_number} contact-sheet byte count is stale')
        if readback.get('frame_observation_blake3') and readback['frame_observation_blake3'] != content_identity(observation_path)['value']:
            raise ValueError(f'Page {page_number} observation BLAKE3 is stale')

        obs_rows, rb_rows = observation.get('frames'), readback.get('frames')
        if not isinstance(obs_rows, list) or not obs_rows or not isinstance(rb_rows, list) or len(obs_rows) != len(rb_rows):
            raise ValueError(f'Page {page_number} observation/readback frame rows do not join')
        rb_by_index = {}
        for row in rb_rows:
            index = row.get('index')
            if index in rb_by_index:
                raise ValueError(f'Page {page_number} has duplicate readback frame join: {index}')
            rb_by_index[index] = row
        finalized_frames = []
        for note in obs_rows:
            index = note.get('index')
            if index in seen or index not in manifest_by_index:
                raise ValueError(f'Duplicate or undeclared observation frame join: {index!r}')
            seen.add(index)
            frame, readback_frame = manifest_by_index[index], rb_by_index.get(index)
            if readback_frame is None:
                raise ValueError(f'Page {page_number} is missing readback frame f{index}')
            frame_path = Path(frame['path'])
            identity = content_identity(frame_path)
            path = _resolved_ref(note.get('path'), observation_path, f'frame {index} observation path')
            rb_path = _resolved_ref(readback_frame.get('path'), readback_path, f'frame {index} readback path')
            if path != frame_path or rb_path != frame_path:
                raise ValueError(f'Frame {index} path does not join to the source manifest')
            if note.get('pts') != frame.get('pts') or readback_frame.get('pts') != frame.get('pts'):
                raise ValueError(f'Frame {index} PTS does not join to source manifest')
            if abs(float(note.get('seconds')) - float(frame.get('seconds'))) > 1e-9 or abs(float(readback_frame.get('seconds')) - float(frame.get('seconds'))) > 1e-9:
                raise ValueError(f'Frame {index} seconds do not join to source manifest')
            expected_seconds = float((int(frame['pts']) - first_pts) * time_base) + origin
            if abs(expected_seconds - float(frame['seconds'])) > 1e-6:
                raise ValueError(f'Frame {index} source PTS/time_base clock disagrees')
            for pin in (note.get('blake3'), readback_frame.get(hash_field)):
                if pin != identity['value']:
                    raise ValueError(f'Frame {index} BLAKE3 is stale')
            if readback_frame.get('bytes') != identity['bytes']:
                raise ValueError(f'Frame {index} byte count is stale')
            extraction_frame = extraction_by_index.get(index)
            if not extraction_frame or extraction_frame.get('blake3') != identity['value'] or extraction_frame.get('bytes') != identity['bytes']:
                raise ValueError(f'Frame {index} extraction readback is missing or stale')
            note_text = note.get('visual_observation')
            if not isinstance(note_text, str) or not note_text.strip() or not note.get(state_field):
                raise ValueError(f'Frame {index} requires a nonempty note and {state_field}')
            finalized_frames.append({'index': index, 'pts': frame['pts'], 'seconds': frame['seconds'],
                                     'path': str(frame_path), 'identity': identity,
                                     'visual_observation': note_text, state_field: note[state_field]})
        if set(rb_by_index) != {row['index'] for row in obs_rows}:
            raise ValueError(f'Page {page_number} has an extra or unmatched readback frame')
        pages.append({'page': page_number, 'observation': _pinned(observation_path),
                      'readback': _pinned(readback_path), 'contact_sheet': _pinned(contact_obs),
                      'frames': finalized_frames})
    if seen != set(manifest_by_index):
        missing = sorted(set(manifest_by_index) - seen)
        raise ValueError(f'Page observations do not cover all manifest frames: {missing[:8]}')
    journal = {
        'schema': profile['journal_schema'],
        'status': profile['journal_final_status'],
        'validation_scope': profile['validation_scope'],
        'source_manifest': _pinned(manifest_path),
        'extraction_readback': _pinned(extraction_readback_path),
        'source_identity': projection['source']['identity'],
        'frame_count': len(seen),
        'pages': pages,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open('x', encoding='utf-8') as stream:
        json.dump(journal, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    summary = validate_page_journal(output_path, profile)
    return {'output': str(output_path), **summary, 'journal_identity': content_identity(output_path)}
