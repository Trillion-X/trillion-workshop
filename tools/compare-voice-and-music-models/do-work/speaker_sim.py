# Speaker similarity of each line to the clone's reference recording, with the same WeSpeaker ResNet34 model Trillion's
# know-who uses (cosine of 256-number voice embeddings; same-speaker pairs typically score well above 0.5).
# usage: python3 speaker_sim.py <reference wav> <dir> [<dir> ...]
import os, sys, subprocess, glob, warnings
os.environ.setdefault('HF_HUB_OFFLINE', '1'); warnings.filterwarnings('ignore')
import numpy as np, torch
from pyannote.audio import Inference, Model
inf = Inference(Model.from_pretrained('pyannote/wespeaker-voxceleb-resnet34-LM'), window='whole')
def emb(p):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'], check=True, capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).copy()
    v = np.asarray(inf({'waveform': torch.from_numpy(x).unsqueeze(0), 'sample_rate': 16000})).ravel()
    return v / np.linalg.norm(v)
ref = emb(sys.argv[1])
for d in sys.argv[2:]:
    sims = {os.path.basename(f): float(emb(f) @ ref) for f in sorted(glob.glob(os.path.join(d, 'l0*.wav')))}
    print(d, ' '.join(f'{k[:3]} {v:.3f}' for k, v in sims.items()), f'| mean {np.mean(list(sims.values())):.3f}')
