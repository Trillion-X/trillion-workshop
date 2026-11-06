# MOSS-SoundEffect v2.0: COUNT candidates for one prompt, seeds SEED, SEED+1, ... (the maker program of the media-maker
# row moss-soundeffect-v2 in make-pictures-and-sounds.json: the pipeline loads once for every result).
# Each result is DIR/s<seed>.wav with DIR/s<seed>.wav.json beside it (model, prompt, seed, steps, seconds, wall time).
# usage: TORCHDYNAMO_DISABLE=1 <python with moss_soundeffect_v2> -I make-sound-with-moss-soundeffect.py --weights WEIGHTS
#        --prompt TEXT --seconds S --steps STEPS --seed SEED --count COUNT --dir DIR
import argparse
import json, pathlib, sys, time
import soundfile as sf
import torch
from moss_soundeffect_v2 import MossSoundEffectPipeline

ap = argparse.ArgumentParser()
for flag in ('--weights', '--prompt', '--dir'):
    ap.add_argument(flag, required=True)
ap.add_argument('--seconds', type=float, required=True)
for flag in ('--steps', '--seed', '--count'):
    ap.add_argument(flag, type=int, required=True)
A = ap.parse_args()
OUT = pathlib.Path(A.dir)
steps, seeds = A.steps, list(range(A.seed, A.seed + A.count))
device = 'mps' if torch.backends.mps.is_available() else 'cpu'
t0 = time.time()
pipe = MossSoundEffectPipeline.from_pretrained(str(pathlib.Path(A.weights)), torch_dtype=torch.bfloat16, device=device)
print('loaded', device, round(time.time() - t0, 1), 's', flush=True)
s = {'name': OUT.name, 'prompts': [A.prompt], 'seconds': A.seconds}
d = OUT
d.mkdir(parents=True, exist_ok=True)
for seed in seeds:
    files = [d / f's{seed:06d}.wav' for pi in range(len(s['prompts']))]
    if all(f.exists() for f in files):
        continue
    t = time.time()
    a = pipe(prompt=list(s['prompts']), seconds=s['seconds'], num_inference_steps=steps, seed=seed)
    secs = round(time.time() - t, 2)
    for pi, f in enumerate(files):
        sf.write(f, a[pi].float().cpu().numpy().T, pipe.sample_rate, subtype='FLOAT')
        log = open(f'{f}.json', 'w')
        log.write(json.dumps({'model': 'moss-sfx-v2', 'sound': s['name'], 'prompt': s['prompts'][pi], 'seed': seed,
                              'steps': steps, 'seconds': s['seconds'], 'wall_s_batch': secs, 'batch': len(files),
                              'device': device, 'file': str(f)}) + '\n')
        log.close()
    print(s['name'], seed, secs, 's for', len(files), flush=True)
