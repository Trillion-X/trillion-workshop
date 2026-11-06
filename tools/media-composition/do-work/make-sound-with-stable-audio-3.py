# Stable Audio 3 Small-SFX: COUNT candidates for one prompt, seeds SEED, SEED+1, ... (the maker program of the
# media-maker row stable-audio-3-small-sfx in make-pictures-and-sounds.json: the model loads once for every result).
# Weights: WEIGHTS (for example the ungated mirror, sha256-identical to stabilityai/stable-audio-3-small-sfx).
# Each result is DIR/s<seed>.wav with DIR/s<seed>.wav.json beside it (model, prompt, seed, seconds, decoded peak, wall time).
# usage: <python with stable-audio-3> -I make-sound-with-stable-audio-3.py --weights WEIGHTS --prompt TEXT --seconds S
#        --seed SEED --count COUNT --dir DIR [--device mps|cpu]
import argparse
import json, pathlib, sys, time
import numpy as np
import soundfile as sf
import torch
from stable_audio_3.model import StableAudioModel, load_diffusion_cond

ap = argparse.ArgumentParser()
for flag in ('--weights', '--prompt', '--dir'):
    ap.add_argument(flag, required=True)
ap.add_argument('--seconds', type=float, required=True)
ap.add_argument('--seed', type=int, required=True)
ap.add_argument('--count', type=int, required=True)
ap.add_argument('--device')
A = ap.parse_args()
W = pathlib.Path(A.weights)
OUT = pathlib.Path(A.dir)
if not (W / 'model_config.json').is_file():
    sys.exit(f'{W} holds no model_config.json: give --weights the Stable Audio 3 Small-SFX weights folder')
device = A.device or ('mps' if torch.backends.mps.is_available() else 'cpu')
cfg = json.loads((W / 'model_config.json').read_text())
for c in cfg['model']['conditioning']['configs']:
    if c['type'] == 't5gemma':
        c['config'].pop('repo_id', None)
        c['config']['model_path'] = str(W)
t0 = time.time()
model = StableAudioModel(load_diffusion_cond(cfg, str(W / 'model.safetensors'), device=device, model_half=False), cfg, device, False)
model.use_lora, model.lora_names = False, []
print('loaded', device, round(time.time() - t0, 1), 's', flush=True)
s = {'name': OUT.name, 'seconds': A.seconds}
prompt = A.prompt
rate = cfg['sample_rate']
d = OUT
d.mkdir(parents=True, exist_ok=True)
for seed in range(A.seed, A.seed + A.count):
    f = d / f's{seed:06d}.wav'
    if f.exists():
        continue
    t = time.time()
    # the library clamps decoded audio to [-1, 1], which hard-clips loud generations: decode the latents here
    # and scale the whole clip under full scale instead
    lat = model.generate(prompt=prompt, duration=s['seconds'], seed=seed, return_latents=True)
    pt = model.model.pretransform
    with torch.inference_mode():
        a = pt.decode(lat.to(next(pt.parameters()).dtype))
    x = a[0].float().cpu().numpy().T[:int(s['seconds'] * rate)]
    peak = float(np.abs(x).max())
    x = x / max(peak, 1.0) * (10 ** (-0.1 / 20) if peak >= 1.0 else 1.0)
    secs = round(time.time() - t, 2)
    sf.write(f, x, rate, subtype='FLOAT')
    log = open(f'{f}.json', 'w')
    log.write(json.dumps({'model': 'sa3-small-sfx', 'sound': s['name'], 'prompt': prompt, 'seed': seed,
                          'seconds': s['seconds'], 'decoded_peak': round(peak, 3), 'wall_s': secs, 'device': device, 'file': str(f)}) + '\n'); log.flush()
    log.close()
    print(s['name'], 0, seed, secs, 's', flush=True)
