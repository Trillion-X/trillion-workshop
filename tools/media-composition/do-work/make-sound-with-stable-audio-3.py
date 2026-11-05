# Stable Audio 3 Small-SFX: one candidate per (sound, prompt, seed) row of tools/sfx-gen/prompts.json.
# Weights: models/sa3-small-sfx (ungated mirror, sha256-identical to stabilityai/stable-audio-3-small-sfx).
# usage: venv-sa3/bin/python -I scripts/gen_sa3.py [device]
import json, pathlib, sys, time
import numpy as np
import soundfile as sf
import torch
from stable_audio_3.model import StableAudioModel, load_diffusion_cond

G = pathlib.Path(__file__).resolve().parents[1]
W = G / 'models/sa3-small-sfx'
OUT = G / 'out/gen/sa3'
device = sys.argv[1] if len(sys.argv) > 1 else ('mps' if torch.backends.mps.is_available() else 'cpu')
cfg = json.loads((W / 'model_config.json').read_text())
for c in cfg['model']['conditioning']['configs']:
    if c['type'] == 't5gemma':
        c['config'].pop('repo_id', None)
        c['config']['model_path'] = str(W)
t0 = time.time()
model = StableAudioModel(load_diffusion_cond(cfg, str(W / 'model.safetensors'), device=device, model_half=False), cfg, device, False)
model.use_lora, model.lora_names = False, []
print('loaded', device, round(time.time() - t0, 1), 's', flush=True)
P = json.loads((G / 'prompts.json').read_text())
rate = cfg['sample_rate']
log = open(OUT.parent / 'sa3.jsonl', 'a')
for s in P['sounds']:
    d = OUT / s['name']
    d.mkdir(parents=True, exist_ok=True)
    for pi, prompt in enumerate(s['prompts']):
        for seed in P['seeds']:
            f = d / f'p{pi}-s{seed}.wav'
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
            log.write(json.dumps({'model': 'sa3-small-sfx', 'sound': s['name'], 'prompt': prompt, 'seed': seed,
                                  'seconds': s['seconds'], 'decoded_peak': round(peak, 3), 'wall_s': secs, 'device': device, 'file': str(f)}) + '\n'); log.flush()
            print(s['name'], pi, seed, secs, 's', flush=True)
