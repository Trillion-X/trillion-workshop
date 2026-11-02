#!/usr/bin/env python3
"""Face landmarks of still images from Apple Vision, as JSON on stdout: vision_landmarks.py <image>... 
Run with a macOS python that has the Vision and Quartz bindings (pyobjc-framework-Vision): for each image a list of faces, each {box: [x, y, w, h] (fraction of the image, origin bottom left),
eye_open: [left, right] (eye height / eye width from the eye contour), mouth_open: inner lips height / width, or null when Vision found no inner lips}."""
import json
import sys

import Vision
from Foundation import NSURL


def _openness(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    w = max(xs) - min(xs)
    return (max(ys) - min(ys)) / w if w else None


def _points(region):
    return [(region.normalizedPoints()[i].x, region.normalizedPoints()[i].y) for i in range(region.pointCount())] if region is not None else []


def faces(path):
    req = Vision.VNDetectFaceLandmarksRequest.alloc().init()
    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(path), None)
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        raise SystemExit(f'vision failed on {path}: {err}')
    out = []
    for f in req.results() or []:
        lm = f.landmarks()
        bb = f.boundingBox()
        eyes = [_openness(_points(lm.leftEye())), _openness(_points(lm.rightEye()))] if lm else [None, None]
        mouth = _openness(_points(lm.innerLips())) if lm else None
        out.append({'box': [bb.origin.x, bb.origin.y, bb.size.width, bb.size.height], 'eye_open': eyes, 'mouth_open': mouth})
    return out


if __name__ == '__main__':
    print(json.dumps({p: faces(p) for p in sys.argv[1:]}))
