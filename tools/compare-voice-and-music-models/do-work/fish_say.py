# Evaluation only (Fish Audio Research License: non-commercial): say the one-place lines in Fish S2 Pro, cloned from
# the same reference recording the Trillion voice uses, so they can be compared with the film's existing lines.
# usage: fish-venv/bin/python -I fish_say.py <model id> <out dir> <ref wav> <ref text> <line id>=<text> ...
import sys, time, pathlib
import numpy as np, soundfile as sf
from mlx_audio.tts.utils import load_model
from mlx_audio.utils import load_audio
model_id, out, ref, ref_text = sys.argv[1:5]
out = pathlib.Path(out); out.mkdir(parents=True, exist_ok=True)
t = time.time(); model = load_model(model_id); print(f'load {time.time() - t:.1f} s', flush=True)
ref = load_audio(ref, sample_rate=model.sample_rate)
for arg in sys.argv[5:]:
    lid, text = arg.split('=', 1)
    t = time.time()
    segs = list(model.generate(text=text, ref_audio=ref, ref_text=ref_text, verbose=False))
    audio = np.concatenate([np.array(s.audio, dtype=np.float32) for s in segs])
    sf.write(out / f'{lid}.wav', audio, model.sample_rate, subtype='PCM_24')
    print(f'{lid}: {len(audio) / model.sample_rate:.2f} s audio in {time.time() - t:.1f} s ({model.sample_rate} Hz)', flush=True)
