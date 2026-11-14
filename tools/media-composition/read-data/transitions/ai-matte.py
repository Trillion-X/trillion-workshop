#!/usr/bin/env python3
"""ai-matte.py A B OUT DUR W H FPS

AI object-reveal transition (the Kolder fly-through / masking move, automated with roto). It runs
Robust Video Matting (RVM, no green screen) on clip A to matte the SUBJECT per frame, holds the subject
over a background that crossfades from A to B, then fades the subject out to land on full B. This is a
`process` renderer for media-composition: the transition primitive never changes, the "renderer" is
DATA, and swapping the model (SAM2, a future matte net) is a one-row change. Requires torch+torchvision
(present) and the RVM mobilenetv3 weights (auto-downloaded to the torch hub cache).

  A,B     input clips (already tail/head subclips of length ~DUR)
  OUT     output mp4
  DUR,W,H,FPS  geometry the compositor substitutes
"""
import sys, os, glob, subprocess, numpy as np, torch
from PIL import Image

A, B, OUT, DUR, W, H, FPS = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), float(sys.argv[7])
work = OUT + '.work'
for d in ('a', 'b', 'o'):
    os.makedirs(f'{work}/{d}', exist_ok=True)

def extract(src, dst):
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-vf', f'scale={W}:{H},fps={FPS}', f'{dst}/%04d.png'], check=True)
extract(A, f'{work}/a'); extract(B, f'{work}/b')

model = torch.hub.load('PeterL1n/RobustVideoMatting', 'mobilenetv3'); model.eval()

def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)

af = sorted(glob.glob(f'{work}/a/*.png')); bf = sorted(glob.glob(f'{work}/b/*.png'))
n = min(len(af), len(bf))
rec = [None] * 4
with torch.no_grad():
    for i in range(n):
        P = i / max(1, n - 1)
        a = np.asarray(Image.open(af[i]).convert('RGB'), dtype=np.float32) / 255.0
        b = np.asarray(Image.open(bf[i]).convert('RGB'), dtype=np.float32) / 255.0
        src = torch.from_numpy(a).permute(2, 0, 1).unsqueeze(0)
        fgr, pha, *rec = model(src, *rec, downsample_ratio=0.4)
        alpha = pha[0, 0].numpy()[..., None]           # HxWx1 subject matte
        subj = alpha * (1.0 - smoothstep(0.55, 1.0, P))  # hold subject, then fade it out
        bg = a * (1.0 - P) + b * P                       # background crossfades A -> B behind the subject
        out = a * subj + bg * (1.0 - subj)
        Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8)).save(f'{work}/o/{i:04d}.png')

subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', f'{work}/o/%04d.png',
                '-f', 'lavfi', '-t', str(DUR), '-i', 'anullsrc=r=48000:cl=stereo',
                '-map', '0:v', '-map', '1:a', '-t', str(DUR), '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
                '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '256k', OUT], check=True)
print(f'ai-matte: {n} frames matted -> {OUT}')
