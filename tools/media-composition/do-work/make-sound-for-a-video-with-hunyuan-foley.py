# section boundaries from the cue plan, each window is scored from picture + prompt, and the windows are joined end to end
# into one 48 kHz stereo SFX stem (5 ms fades at the seams, so every sample keeps its film time).
# usage: HF_HOME=models/hf venv-hunyuan/bin/python -I scripts/gen_hunyuan.py PICTURE.mp4 CUES.json OUT_DIR [SEED]
# The window cuts are video encodes: run under /tmp/hf-render.lock (taken here around the ffmpeg calls only).
import json, pathlib, subprocess, sys, time
import numpy as np
import soundfile as sf
import torch

G = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(G / 'src/HunyuanVideo-Foley'))
from hunyuanvideo_foley.utils.model_utils import load_model, denoise_process   # noqa: E402
from hunyuanvideo_foley.utils.feature_utils import feature_process             # noqa: E402

PROMPT = 'soft UI foley for a calm product film: clicks, key taps, soft whooshes, low impacts, no music'
NEG = 'music, speech, singing, noisy, harsh'
MAX = 15.0
pic, plan, out = pathlib.Path(sys.argv[1]), json.loads(pathlib.Path(sys.argv[2]).read_text()), pathlib.Path(sys.argv[3])
seed = int(sys.argv[4]) if len(sys.argv) > 4 else 1
out.mkdir(parents=True, exist_ok=True)
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
lock = pathlib.Path('/tmp/hf-render.lock')
while True:
    try:
        lock.mkdir()
        break
    except FileExistsError:
        time.sleep(20)
try:
    for i, (x, y) in enumerate(wins):
        f = out / f'win{i}.mp4'
        if not f.exists():
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{x:.3f}', '-i', str(pic), '-t', f'{y - x:.3f}',
                            '-an', '-r', '25', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', str(f)], check=True)
finally:
    lock.rmdir()
device = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
t0 = time.time()
model_dict, cfg = load_model(str(G / 'models/hunyuan-foley'), str(G / 'src/HunyuanVideo-Foley/configs/hunyuanvideo-foley-xxl.yaml'), device)
print('loaded', device, round(time.time() - t0, 1), 's', flush=True)
parts, log = [], []
for i, (x, y) in enumerate(wins):
    torch.manual_seed(seed); np.random.seed(seed)
    t = time.time()
    vf, tf, secs = feature_process(str(out / f'win{i}.mp4'), PROMPT, model_dict, cfg, neg_prompt=NEG)
    audio, sr = denoise_process(vf, tf, secs, model_dict, cfg, guidance_scale=4.5, num_inference_steps=50)
    w = audio[0].float().cpu().numpy().T
    n = int(round((y - x) * sr))
    w = np.pad(w[:n], ((0, max(0, n - len(w))), (0, 0)))   # exactly the window's length, so the seams stay on time
    sf.write(out / f'win{i}.wav', w, sr, subtype='FLOAT')
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
sf.write(out / 'stem.wav', stem, sr, subtype='FLOAT')
(out / 'run.json').write_text(json.dumps({'model': 'HunyuanVideo-Foley XXL', 'prompt': PROMPT, 'neg_prompt': NEG, 'seed': seed,
                                          'steps': 50, 'guidance': 4.5, 'device': str(device), 'windows': log,
                                          'load_s': round(time.time() - t0, 1)}, indent=1))
print('wrote', out / 'stem.wav', round(len(stem) / sr, 3), 's', flush=True)
