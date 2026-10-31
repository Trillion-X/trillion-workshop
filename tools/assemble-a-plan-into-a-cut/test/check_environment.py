"""Print one JSON line saying whether this computer can run the cutter's tests: python3 with numpy, soundfile, Pillow and blake3,
and ffmpeg with ffprobe on the path."""
import importlib.util
import json
import shutil

missing = [m for m in ('numpy', 'soundfile', 'PIL', 'blake3') if importlib.util.find_spec(m) is None]
missing += [p for p in ('ffmpeg', 'ffprobe') if shutil.which(p) is None]
print(json.dumps({'ok': not missing, 'reason': f'missing {", ".join(missing)}' if missing else ''}))
