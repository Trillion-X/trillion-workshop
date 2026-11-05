# MOSS-SoundEffect v2.0: candidates for each sound in tools/sfx-gen/prompts.json (both prompts in one batch per seed).
# usage: TORCHDYNAMO_DISABLE=1 venv-moss/bin/python -I scripts/gen_moss.py STEPS SEED [SEED ...]
import json, pathlib, sys, time
import soundfile as sf
import torch
from moss_soundeffect_v2 import MossSoundEffectPipeline

G = pathlib.Path(__file__).resolve().parents[1]
OUT = G / 'out/gen/moss'
steps, seeds = int(sys.argv[1]), [int(s) for s in sys.argv[2:]]
device = 'mps' if torch.backends.mps.is_available() else 'cpu'
t0 = time.time()
pipe = MossSoundEffectPipeline.from_pretrained(str(G / 'models/moss-sfx-v2'), torch_dtype=torch.bfloat16, device=device)
print('loaded', device, round(time.time() - t0, 1), 's', flush=True)
P = json.loads((G / 'prompts.json').read_text())
log = open(OUT.parent / 'moss.jsonl', 'a')
for s in P['sounds']:
    d = OUT / s['name']
    d.mkdir(parents=True, exist_ok=True)
    for seed in seeds:
        files = [d / f'p{pi}-s{seed}.wav' for pi in range(len(s['prompts']))]
        if all(f.exists() for f in files):
            continue
        t = time.time()
        a = pipe(prompt=list(s['prompts']), seconds=s['seconds'], num_inference_steps=steps, seed=seed)
        secs = round(time.time() - t, 2)
        for pi, f in enumerate(files):
            sf.write(f, a[pi].float().cpu().numpy().T, pipe.sample_rate, subtype='FLOAT')
            log.write(json.dumps({'model': 'moss-sfx-v2', 'sound': s['name'], 'prompt': s['prompts'][pi], 'seed': seed,
                                  'steps': steps, 'seconds': s['seconds'], 'wall_s_batch': secs, 'batch': len(files),
                                  'device': device, 'file': str(f)}) + '\n')
        log.flush()
        print(s['name'], seed, secs, 's for', len(files), flush=True)
