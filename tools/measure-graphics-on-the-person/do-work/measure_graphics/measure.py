"""The per-frame numbers and the two law verdicts.

Three layers are measured separately: graphics (cards, labels, panels, titles), captions and pose marks. Per frame and
per layer: the layer's pixels, the share of them on the person mask, the share on the face region, and the pixels outside
each platform's safe rectangle. Each law reads its own bar from its row; nothing about a bar is written here.

  graphics-never-cover-the-person: graphics person share <= graphics_person_overlap_max, and every layer's face share
    <= any_layer_face_overlap_max; a frame with a person and no face point fails.
  everything-inside-platform-safe-zones: every layer's pixels inside every requested platform's safe rectangle. The row
    gives no number (zones_from only), so the bar is none outside: outside_px_max 0. The verdict records that rule.
"""
import numpy as np

from . import layers, people, free

LAYERS = ('graphics', 'captions', 'pose')
LAW_CHECKS = {
    'graphics-never-cover-the-person': 'workflow:check-graphics-never-cover-the-person',
    'everything-inside-platform-safe-zones': 'workflow:check-inside-platform-safe-zones',
}
OUTSIDE_PX_MAX = 0


def _share(part, whole):
    return part / whole if whole else 0.0


def _worst(series, key):
    best = max(series, key=lambda f: (f[key], -f['frame']))
    return {'value': best[key], 'frame': best['frame'], 't': best['t']}


def measure_layers(out_dir, layer_paths, rects_by_platform, width, height):
    """layer_paths: {layer name: path}. rects_by_platform: {platform id: rect dict in this picture's pixels}.

    Returns {'frames': [per-frame dicts], 'layers': [names], 'platforms': [ids]}.
    """
    meta = people.read_meta(out_dir)
    readers = {name: layers.read_masks(path, width, height) for name, path in layer_paths.items()}
    frames = []
    for index in range(meta['frames']):
        person, face = people.load_masks(out_dir, index)
        person_px_frame = int(person.sum())
        face_found = bool(face.any())
        row = {'frame': index, 't': round(index / meta['fps'], 6), 'person_px': person_px_frame,
               'face_px': int(face.sum()), 'face_unresolved': bool(person_px_frame > 0 and not face_found), 'layers': {}}
        for name, reader in readers.items():
            mask = next(reader, None)
            if mask is None:
                raise layers.LayerError(f'{layer_paths[name]} ends at frame {index}; the clean picture has {meta["frames"]} frames')
            px = int(mask.sum())
            entry = {'px': px, 'person_px': int((mask & person).sum()), 'face_px': int((mask & face).sum()),
                     'outside_px': {}, 'person_share': 0.0, 'face_share': 0.0}
            entry['person_share'] = _share(entry['person_px'], px)
            entry['face_share'] = _share(entry['face_px'], px)
            for pid, rect in rects_by_platform.items():
                inside = int(mask[rect['y0']:rect['y1'], rect['x0']:rect['x1']].sum())
                entry['outside_px'][pid] = px - inside
            row['layers'][name] = entry
        frames.append(row)
    for name in readers:
        leftover = next(readers[name], None)
        if leftover is not None:
            raise layers.LayerError(f'{layer_paths[name]} has more frames than the clean picture ({meta["frames"]})')
    return {'frames': frames, 'layers': list(layer_paths), 'platforms': list(rects_by_platform)}


def summarize(result):
    frames = result['frames']
    out = {'frames': len(frames), 'layers': {}}
    for name in result['layers']:
        series = [dict(frame=f['frame'], t=f['t'], px=f['layers'][name]['px'],
                       person_share=f['layers'][name]['person_share'], face_share=f['layers'][name]['face_share'],
                       outside_px={p: f['layers'][name]['outside_px'][p] for p in result['platforms']})
                  for f in frames]
        out['layers'][name] = {
            'px_max': _worst(series, 'px'),
            'person_share_max': _worst(series, 'person_share'),
            'face_share_max': _worst(series, 'face_share'),
            'outside_px_max': {p: _worst([{'frame': s['frame'], 't': s['t'], 'v': s['outside_px'][p]} for s in series], 'v')
                               for p in result['platforms']},
        }
    out['unresolved_face_frames'] = [f['t'] for f in frames if f['face_unresolved']]
    return out


def law_graphics(result, bar, summary):
    gp_max = bar['graphics_person_overlap_max']
    face_max = bar['any_layer_face_overlap_max']
    problems = []
    if summary['layers']['graphics']['person_share_max']['value'] > gp_max:
        problems.append(f'graphics cover the person: worst share {summary["layers"]["graphics"]["person_share_max"]["value"]:.6f} '
                        f'at {summary["layers"]["graphics"]["person_share_max"]["t"]} s (max {gp_max})')
    for name in result['layers']:
        worst = summary['layers'][name]['face_share_max']
        if worst['value'] > face_max:
            problems.append(f'{name} covers the face: worst share {worst["value"]:.6f} at {worst["t"]} s (max {face_max})')
    if summary['unresolved_face_frames']:
        problems.append(f'face not detected while a person is on the frame at {len(summary["unresolved_face_frames"])} frames')
    return ('pass', 'graphics clear of the person and the face on every frame') if not problems else ('fail', '; '.join(problems))


def law_safe_zones(result, summary):
    problems = []
    for name in result['layers']:
        for pid, worst in summary['layers'][name]['outside_px_max'].items():
            if worst['value'] > OUTSIDE_PX_MAX:
                problems.append(f'{name} outside {pid} safe zone: {worst["value"]} px at {worst["t"]} s')
    return ('pass', 'every layer inside every safe zone on every frame') if not problems else ('fail', '; '.join(problems))


def laws_verdicts(result, summary, laws, zone_rows):
    """laws: {law id: parsed bar}. zone_rows: {platform id: row id}. Returns one verdict per law id."""
    out = {}
    for law_id, bar in laws.items():
        if law_id == 'graphics-never-cover-the-person':
            verdict, reason = law_graphics(result, bar, summary)
        elif law_id == 'everything-inside-platform-safe-zones':
            verdict, reason = law_safe_zones(result, summary)
        else:
            raise ValueError(f'no measurement for law {law_id}')
        out[law_id] = {'check_id': LAW_CHECKS[law_id], 'verdict': verdict, 'reason': reason,
                       'bar': {'law': law_id, 'values': bar, 'safe_zone_rows': zone_rows if law_id == 'everything-inside-platform-safe-zones' else None,
                               'outside_px_max': OUTSIDE_PX_MAX if law_id == 'everything-inside-platform-safe-zones' else None}}
    return out
