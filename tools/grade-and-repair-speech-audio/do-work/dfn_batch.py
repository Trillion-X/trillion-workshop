"""Run DeepFilterNet3 over wav files. Runs inside the python that has DeepFilterNet: dfn_batch.py <soft_limit_db> <in.wav> <out.wav> [<in.wav> <out.wav> ...].

Writes <out.wav> (full suppression) and <out>.soft.wav (suppression limited to soft_limit_db, for noise that overlaps the voice)."""
import sys

import soundfile as sf
import torch
from df.enhance import enhance, init_df

soft_db = float(sys.argv[1])
model, df_state, _ = init_df()
sr = df_state.sr()
pairs = sys.argv[2:]
for src, dst in zip(pairs[::2], pairs[1::2]):
    x, in_sr = sf.read(src, dtype="float32", always_2d=True)
    assert in_sr == sr, f"{src} is {in_sr} Hz, model wants {sr}"
    audio = torch.from_numpy(x.mean(axis=1))[None, :]
    sf.write(dst, enhance(model, df_state, audio)[0].numpy(), sr, subtype="PCM_24")
    sf.write(dst[:-4] + ".soft.wav", enhance(model, df_state, audio, atten_lim_db=soft_db)[0].numpy(), sr, subtype="PCM_24")
    print("dfn", dst, flush=True)
