"""One layer as per-frame boolean masks. An alpha video (its alpha channel is the layer) or a mask video (white = layer).

A layer is read only when its size equals the clean picture's: a size mismatch is refused, never scaled.
"""
import json
import subprocess

import numpy as np

ALPHA_FORMAT_TOKENS = ('rgba', 'bgra', 'argb', 'abgr', 'yuva', 'gbrap', 'ya')
MASK_THRESHOLD = 128


class LayerError(RuntimeError):
    pass


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height,pix_fmt,r_frame_rate,nb_frames', '-of', 'json', path],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise LayerError(f'cannot probe {path}: {out.stderr.strip()}')
    streams = json.loads(out.stdout).get('streams') or []
    if not streams:
        raise LayerError(f'no video stream in {path}')
    s = streams[0]
    num, den = (s['r_frame_rate'].split('/') + ['1'])[:2]
    fps = float(num) / float(den) if float(den) else 0.0
    return {'width': int(s['width']), 'height': int(s['height']), 'pix_fmt': s['pix_fmt'], 'fps': fps}


def has_alpha(pix_fmt):
    return any(token in pix_fmt for token in ALPHA_FORMAT_TOKENS)


def read_masks(path, width, height):
    """Yields one boolean (height, width) array per frame: True where the layer is drawn."""
    info = probe(path)
    if (info['width'], info['height']) != (width, height):
        raise LayerError(f'{path} is {info["width"]}x{info["height"]}, the clean picture is {width}x{height}: refused, not scaled')
    alpha = has_alpha(info['pix_fmt'])
    channels, pix_fmt = (4, 'rgba') if alpha else (1, 'gray')
    proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', pix_fmt, '-'],
                            stdout=subprocess.PIPE)
    size = width * height * channels
    try:
        while True:
            raw = proc.stdout.read(size)
            if len(raw) < size:
                break
            frame = np.frombuffer(raw, np.uint8).reshape(height, width, channels)
            values = frame[..., 3] if alpha else frame[..., 0]
            yield values >= MASK_THRESHOLD
    finally:
        proc.stdout.close()
        if proc.wait() != 0:
            raise LayerError(f'ffmpeg could not decode {path}')


def count_frames(path, width, height):
    return sum(1 for _ in read_masks(path, width, height))
