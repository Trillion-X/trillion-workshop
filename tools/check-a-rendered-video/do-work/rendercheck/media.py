"""ffmpeg/ffprobe access: probe, small gray/rgb frame arrays, overlay alpha, mono audio."""
import json
import subprocess

import numpy as np


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
                         capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    v = next(s for s in j['streams'] if s['codec_type'] == 'video')
    num, den = v['r_frame_rate'].split('/')
    has_audio = any(s['codec_type'] == 'audio' for s in j['streams'])
    return {'fps': int(num) / int(den), 'width': int(v['width']), 'height': int(v['height']),
            'duration': float(j['format']['duration']), 'has_audio': has_audio}


def _raw(cmd):
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode:
        raise RuntimeError(r.stderr.decode()[-500:])
    return r.stdout


def frames(path, w, h, pix='gray', ss=0.0, t=None, vf_pre=''):
    """All frames as uint8 array (n, h, w[, 3]). vf_pre is prepended to the filter chain (e.g. alphaextract,)."""
    ch = 3 if pix == 'rgb24' else 1
    cmd = ['ffmpeg', '-nostdin', '-v', 'error'] + (['-ss', f'{ss:.4f}'] if ss else []) + ['-i', path] + \
          (['-t', f'{t:.4f}'] if t else []) + ['-vf', f'{vf_pre}scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', pix, '-']
    a = np.frombuffer(_raw(cmd), np.uint8)
    return a.reshape(-1, h, w, 3) if ch == 3 else a.reshape(-1, h, w)


def alpha_frames(path, w, h, ss=0.0, t=None):
    return frames(path, w, h, 'gray', ss, t, vf_pre='alphaextract,')


def rgba_frame(path, w, h, ss):
    """One frame of an alpha movie as float arrays (rgb 0..1 straight, alpha 0..1)."""
    rgb = frames(path, w, h, 'rgb24', ss, 0.05)[0].astype(np.float32) / 255
    al = frames(path, w, h, 'gray', ss, 0.05, vf_pre='alphaextract,')[0].astype(np.float32) / 255
    return rgb, al


def audio(path, sr=16000):
    raw = _raw(['ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', str(sr), '-f', 's16le', '-'])
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768, sr
