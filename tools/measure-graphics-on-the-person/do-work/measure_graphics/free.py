"""Free regions: the part of a platform's safe rectangle that no person or face mask touches, margin included.

A renderer asks for one frame's free rectangles and places its graphic inside one of them. Nothing here knows a platform's
numbers: the safe rectangle is passed in, read from the platform_safe_zones row by the caller (see zones).
"""
import cv2
import numpy as np

from . import people


def zone_rect(zone_row, width, height):
    """The safe rectangle of a platform_safe_zones row, scaled from the row's frame to this picture's size (never a literal)."""
    frame_w, frame_h = zone_row['frame_width'], zone_row['frame_height']
    rect = zone_row['safe']['rect_px']
    return {'x0': round(rect['x0'] * width / frame_w), 'x1': round(rect['x1'] * width / frame_w),
            'y0': round(rect['y0'] * height / frame_h), 'y1': round(rect['y1'] * height / frame_h)}


def shared_zone_rect(zone_rows, width, height):
    """The rectangle inside every given platform's safe zone: where one graphic may sit for all of them."""
    rects = [zone_rect(row, width, height) for row in zone_rows]
    return {'x0': max(r['x0'] for r in rects), 'x1': min(r['x1'] for r in rects),
            'y0': max(r['y0'] for r in rects), 'y1': min(r['y1'] for r in rects)}


def blocked_mask(person, face, margin_px):
    blocked = (person | face).astype(np.uint8) * 255
    if margin_px > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * margin_px + 1, 2 * margin_px + 1))
        blocked = cv2.dilate(blocked, kernel)
    return blocked > 0


def free_mask(rect, person, face, margin_px):
    height, width = person.shape
    inside = np.zeros((height, width), bool)
    inside[rect['y0']:rect['y1'], rect['x0']:rect['x1']] = True
    return inside & ~blocked_mask(person, face, margin_px)


def maximal_rects(mask, min_side):
    """Rectangles (x0, y0, x1, y1; end exclusive) that cover the True pixels of mask, row runs merged downwards."""
    height = mask.shape[0]
    active = {}
    found = []
    for y in range(height + 1):
        runs = set()
        if y < height:
            edges = np.diff(np.concatenate(([0], mask[y].astype(np.int8), [0])))
            runs = set(zip(np.where(edges == 1)[0].tolist(), np.where(edges == -1)[0].tolist()))
        for key in [k for k in active if k not in runs]:
            top = active.pop(key)
            found.append((key[0], top, key[1], y))
        for key in runs:
            active.setdefault(key, y)
    rects = [{'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1, 'area': (x1 - x0) * (y1 - y0)}
             for x0, y0, x1, y1 in found if x1 - x0 >= min_side and y1 - y0 >= min_side]
    return sorted(rects, key=lambda r: (-r['area'], r['y0'], r['x0']))


def free_regions(out_dir, frame_index, zone_rows, margin_px, min_side=40):
    """The free rectangles of one frame of an analysed clip (its masks in out_dir), largest first.

    zone_rows: the platform_safe_zones rows the graphic must sit inside (their shared rectangle is used).
    margin_px: how far a graphic must stay from the person and face masks.
    Returns {'frame', 't', 'zones', 'zone_rect', 'margin_px', 'free': [{x0, y0, x1, y1, area}], 'largest': rect or None}.
    """
    meta = people.read_meta(out_dir)
    if not 0 <= frame_index < meta['frames']:
        raise ValueError(f'frame {frame_index} is outside the analysed clip (0..{meta["frames"] - 1})')
    person, face = people.load_masks(out_dir, frame_index)
    rect = shared_zone_rect(zone_rows, meta['width'], meta['height'])
    rects = maximal_rects(free_mask(rect, person, face, margin_px), min_side)
    return {'frame': frame_index, 't': round(frame_index / meta['fps'], 6), 'zones': [z['id'] for z in zone_rows],
            'zone_rect': rect, 'margin_px': margin_px, 'free': rects, 'largest': rects[0] if rects else None}


def free_regions_span(out_dir, first, last, zone_rows, margin_px, min_side=40):
    """The free rectangles that hold on every frame from first to last (inclusive): a static graphic's place.

    The free masks of all those frames are intersected first, so a rectangle here stays free for the whole span.
    zone_rows: the platform_safe_zones rows the graphic must sit inside (their shared rectangle is used).
    """
    meta = people.read_meta(out_dir)
    if not (0 <= first <= last < meta['frames']):
        raise ValueError(f'span {first}..{last} is outside the analysed clip (0..{meta["frames"] - 1})')
    rect = shared_zone_rect(zone_rows, meta['width'], meta['height'])
    held = None
    for index in range(first, last + 1):
        person, face = people.load_masks(out_dir, index)
        mask = free_mask(rect, person, face, margin_px)
        held = mask if held is None else held & mask
    rects = maximal_rects(held, min_side)
    return {'first': first, 'last': last, 'zones': [z['id'] for z in zone_rows], 'zone_rect': rect, 'margin_px': margin_px,
            'free': rects, 'largest': rects[0] if rects else None}
