"""Stand-in earshot.audio: load a file as float samples at SR (the test files are written at SR)."""
import soundfile as sf

SR = 48000


def load(path, sr=SR, mono=False, start=None, end=None, cache=True):
    x, rate = sf.read(str(path), always_2d=True)
    if rate != sr:
        raise ValueError(f'the stand-in reads {sr} Hz files only, not {rate}')
    return x.mean(1) if mono else x
