#!/usr/bin/env python3
"""Face landmarks of still images from Apple Vision, as JSON on stdout: vision_landmarks.py <image>... 
Run with a macOS python that has the Vision and Quartz bindings (pyobjc-framework-Vision): for each image a list of faces, each {box: [x, y, w, h] (fraction of the image, origin bottom left),
eye_open: [left, right] (eye height / eye width from the eye contour), mouth_open: inner lips height / width, or null when Vision found no inner lips}.
With --output text, print the first face as eyes/mouth ratios and a pixel box with origin top left."""
import argparse
import json
import os
import sys

import Vision
from Foundation import NSURL


def _openness(points, minimum_points=1):
    if len(points) < minimum_points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    w = max(xs) - min(xs)
    return (max(ys) - min(ys)) / w if w else None


def _points(region):
    return [(region.normalizedPoints()[i].x, region.normalizedPoints()[i].y) for i in range(region.pointCount())] if region is not None else []


def faces(path, *, include_regions=False, cg_image=None):
    req = Vision.VNDetectFaceLandmarksRequest.alloc().init()
    if cg_image is None:
        handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(path), None)
    else:
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, {})
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        raise SystemExit(f'vision failed on {path}: {err}')
    out = []
    for f in req.results() or []:
        lm = f.landmarks()
        bb = f.boundingBox()
        regions = {'left': _points(lm.leftEye()), 'right': _points(lm.rightEye()), 'mouth': _points(lm.innerLips())} if lm else None
        eyes = [_openness(regions['left']), _openness(regions['right'])] if regions is not None else [None, None]
        mouth = _openness(regions['mouth']) if regions is not None else None
        out.append({'box': [bb.origin.x, bb.origin.y, bb.size.width, bb.size.height], 'eye_open': eyes, 'mouth_open': mouth})
        if include_regions:
            out[-1]['regions'] = regions
    return out


def _image_for_text(path):
    """Use the reference's AppKit decode for both Vision input and pixel size."""
    from AppKit import NSImage
    import objc
    import Quartz
    try:
        owner = NSImage.alloc().initWithContentsOfFile_(path)
        if owner is None:
            return None
        image = owner.CGImageForProposedRect_context_hints_(objc.NULL, None, None)
        if isinstance(image, tuple):
            image = image[0]
        if image is None:
            return None
        return image, (Quartz.CGImageGetWidth(image), Quartz.CGImageGetHeight(image)), owner
    except Exception:
        return None


def _text_line(path, found, size):
    name = os.path.basename(path)
    if not found or found[0].get('regions') is None:
        return f'{name} no face'
    face = found[0]
    regions = face['regions']
    ratios = [_openness(regions[key], minimum_points=3) for key in ('left', 'right', 'mouth')]
    left, right, mouth = [value if value is not None else -1.0 for value in ratios]
    x, y, w, h = face['box']
    width, height = size
    return (f'{name} eyes {(left + right) / 2:.3f} (L {left:.3f} R {right:.3f}) mouth {mouth:.3f} '
            f'box {x * width:.0f} {(1 - (y + h)) * height:.0f} {w * width:.0f} {h * height:.0f}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', choices=('json', 'text'), default='json')
    parser.add_argument('images', nargs='*')
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if args.output == 'json':
        print(json.dumps({p: faces(p) for p in args.images}))
        return
    for path in args.images:
        decoded = _image_for_text(path)
        if decoded is None:
            print(f'{path} unreadable')
            continue
        image, size, owner = decoded
        try:
            found = faces(path, include_regions=True, cg_image=image)
        except SystemExit:
            found = []
        print(_text_line(path, found, size))


if __name__ == '__main__':
    main()
