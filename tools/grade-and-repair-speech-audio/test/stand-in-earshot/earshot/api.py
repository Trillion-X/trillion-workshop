"""Stand-in earshot.api: realness, match and compare answer from the RMS level of the part asked, so a run is repeatable."""
import numpy as np
import soundfile as sf


def _level(path, start=None, end=None):
    x, sr = sf.read(path, always_2d=True)
    x = x.mean(1)[int((start or 0) * sr):int(end * sr) if end is not None else None]
    return float(20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9)) if len(x) else -120.0


def realness(path, start=None, end=None):
    p = round(1 / (1 + np.exp(-(_level(path, start, end) + 30) / 5)), 3)
    return {"p_real": p, "verdict": "real or pro-produced" if p > 0.5 else "likely synthetic"}


def match(path, queries, start=None, end=None):
    level = _level(path, start, end)
    if isinstance(queries, str):
        z = round((level + 40) / 10 + len(queries) / 100, 2)
        return {"z": z, "verdict": "strong" if z > 2 else "weak"}
    return {"results": [{"query": q, "z": round((level + 40) / 10 - i, 2)} for i, q in enumerate(queries)]}


def compare(path, refs, k=3):
    return {"typicality": round(_level(path) / 10, 2), "typicality_verdict": "stand-in", "summary": f"stand-in compare of {k} nearest"}
