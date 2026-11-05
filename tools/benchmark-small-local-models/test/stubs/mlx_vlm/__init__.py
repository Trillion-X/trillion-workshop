"""Stand-in mlx-vlm: the reply names, for each key the prompt asks, the first option the picture's words hold, and
answers a number question with how many of the prompt's words the picture shares."""
import json
import re
import types
from pathlib import Path

from stand_in_words import shared


def load(name):
    return types.SimpleNamespace(config={}), object()


def generate(model, proc, prompt, images, max_tokens=None, temperature=None, verbose=None):
    picture = Path(images[0]).read_text()
    keys = re.findall(r'^"(\w+)": one of (.*)$', prompt, re.M)
    if keys:
        said = {}
        for key, options in keys:
            names = re.findall(r'"([^"]+)"', options)
            said[key] = next((n for n in names if n in picture), names[0])
        for key in re.findall(r'^"(\w+)": (?!one of)', prompt, re.M):
            said[key] = picture.strip()
        return types.SimpleNamespace(text="Here: " + json.dumps(said), generation_tokens=12)
    return types.SimpleNamespace(text=f"{shared(prompt, picture)}", generation_tokens=1)
