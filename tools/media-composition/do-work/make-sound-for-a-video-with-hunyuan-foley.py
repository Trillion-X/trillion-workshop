# HunyuanVideo-Foley XXL on a video's picture: the video is cut into windows of at most --most-seconds (15 s, the model's
# limit) at the section starts given with --at, the
# section boundaries from the cue plan, each window is scored from picture + prompt, and the windows are joined end to end
# into one 48 kHz stereo SFX stem (5 ms fades at the seams, so every sample keeps its film time).
# The maker program of the media-maker row hunyuan-video-foley in make-pictures-and-sounds.json: the model loads once and
# COUNT stems are made, seeds SEED, SEED+1, ..., as DIR/s<seed>.wav with DIR/s<seed>.wav.json beside it; the window
# cuts and each window's sound stay in DIR/windows/.
# usage: <python with HunyuanVideo-Foley's requirements> -I make-sound-for-a-video-with-hunyuan-foley.py --code SRC --weights WEIGHTS
#        --video PICTURE.mp4 --prompt TEXT --negative TEXT --seed SEED --count COUNT --dir DIR [--at S ...] [--most-seconds 15]
#        [--steps 50] [--guidance 4.5] [--lock FOLDER]
# The window cuts are video encodes: with --lock they run under that lock folder (taken here around the ffmpeg calls only),
# so other renders on the computer that take the same lock do not run beside them.
import argparse
import json, pathlib, subprocess, sys, time
import numpy as np
import soundfile as sf
import torch

ap = argparse.ArgumentParser()
for flag in ('--code', '--weights', '--video', '--prompt', '--dir'):
    ap.add_argument(flag, required=True)
ap.add_argument('--negative', default='')
for flag in ('--seed', '--count'):
    ap.add_argument(flag, type=int, required=True)
ap.add_argument('--at', type=float, nargs='*', default=[])
ap.add_argument('--most-seconds', type=float, default=15.0)
ap.add_argument('--steps', type=int, default=50)
ap.add_argument('--guidance', type=float, default=4.5)
ap.add_argument('--lock')
A = ap.parse_args()
G = pathlib.Path(A.code)
if not (G / 'configs/hunyuanvideo-foley-xxl.yaml').is_file():
    sys.exit(f'{G} holds no configs/hunyuanvideo-foley-xxl.yaml: give --code the HunyuanVideo-Foley source folder')
sys.path.insert(0, str(G))
from hunyuanvideo_foley.utils.model_utils import load_model, denoise_process   # noqa: E402
from hunyuanvideo_foley.utils.feature_utils import feature_process             # noqa: E402

PROMPT = A.prompt
NEG = A.negative
MAX = A.most_seconds
pic, out = pathlib.Path(A.video), pathlib.Path(A.dir)
DUR = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(pic)],
                           check=True, capture_output=True, text=True).stdout)
plan = {'DUR': DUR, 'S': {str(k): [v] for k, v in enumerate(A.at) if 0 < v < DUR}}
out.mkdir(parents=True, exist_ok=True)
cuts = out / 'windows'
cuts.mkdir(parents=True, exist_ok=True)
bounds = sorted({0.0, plan['DUR'], *(v[0] for v in plan['S'].values())})
wins, a = [], 0.0
for b in bounds[1:]:            # merge sections into windows <= MAX; split any section longer than MAX in equal parts
    if b - a <= MAX:
        if wins and wins[-1][1] == a and b - wins[-1][0] <= MAX:
            wins[-1] = (wins[-1][0], b)
        else:
            wins.append((a, b))
    else:
        n = int(np.ceil((b - a) / MAX))
        wins += [(a + (b - a) * i / n, a + (b - a) * (i + 1) / n) for i in range(n)]
    a = b
wins = [(round(x, 3), round(y, 3)) for x, y in wins]
print('windows', wins, flush=True)
lock = pathlib.Path(A.lock) if A.lock else None
while lock:
    try:
        lock.mkdir()
        break
    except FileExistsError:
        time.sleep(20)
try:
    for i, (x, y) in enumerate(wins):
        f = cuts / f'win{i}.mp4'
        if not f.exists():
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{x:.3f}', '-i', str(pic), '-t', f'{y - x:.3f}',
                            '-an', '-r', '25', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', str(f)], check=True)
finally:
    if lock:
        lock.rmdir()
device = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
t0 = time.time()
model_dict, cfg = load_model(str(A.weights), str(G / 'configs/hunyuanvideo-foley-xxl.yaml'), device)
print('loaded', device, round(time.time() - t0, 1), 's', flush=True)
for seed in range(A.seed, A.seed + A.count):
    parts, log = [], []
    for i, (x, y) in enumerate(wins):
        torch.manual_seed(seed); np.random.seed(seed)
        t = time.time()
        vf, tf, secs = feature_process(str(cuts / f'win{i}.mp4'), PROMPT, model_dict, cfg, neg_prompt=NEG)
        audio, sr = denoise_process(vf, tf, secs, model_dict, cfg, guidance_scale=A.guidance, num_inference_steps=A.steps)
        w = audio[0].float().cpu().numpy().T
        n = int(round((y - x) * sr))
        w = np.pad(w[:n], ((0, max(0, n - len(w))), (0, 0)))   # exactly the window's length, so the seams stay on time
        sf.write(cuts / f's{seed:06d}-win{i}.wav', w, sr, subtype='FLOAT')
        log.append({'window': [x, y], 'wall_s': round(time.time() - t, 1), 'audio_s': round(len(w) / sr, 3)})
        print(log[-1], flush=True)
        parts.append(w)
    fade = int(0.005 * sr)
    for k, p in enumerate(parts):   # 5 ms fades at each seam; windows abut, so every sample keeps its film time
        if k:
            p[:fade] *= np.linspace(0, 1, fade)[:, None]
        if k < len(parts) - 1:
            p[-fade:] *= np.linspace(1, 0, fade)[:, None]
    stem = np.concatenate(parts)
    sf.write(out / f's{seed:06d}.wav', stem, sr, subtype='FLOAT')
    (out / f's{seed:06d}.wav.json').write_text(json.dumps({'model': 'HunyuanVideo-Foley XXL', 'prompt': PROMPT, 'neg_prompt': NEG, 'seed': seed,
                                                           'steps': A.steps, 'guidance': A.guidance, 'device': str(device), 'windows': log,
                                                           'load_s': round(time.time() - t0, 1)}, indent=1))
    print('wrote', out / f's{seed:06d}.wav', round(len(stem) / sr, 3), 's', flush=True)
