#!/usr/bin/env python3
"""
parts/media-composition/do-work/cut-out-a-person.py

Purpose: cut the person out of one picture and save them on a transparent background (a PNG with alpha). One
U^2-Net human-segmentation model (u2net_human_seg.onnx, the model rembg ships) runs through onnxruntime, which the
deployed container already carries; the model file is baked into the container image by the placement row
(records/workshop-placement-records.json), so nothing is downloaded while a person waits.

Invariants
- Reads only the picture it is given and writes only the output path it is given; the original is never changed.
- The cut-out is the input's own size: the mask the model draws at 320x320 is scaled back to the picture.
- Pure function of (picture, model): no randomness, no network.

Usage: cut-out-a-person.py <picture> <output.png> <model.onnx>
"""
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

SIDE = 320
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
SPREAD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def mask_of(picture: Image.Image, session: ort.InferenceSession) -> Image.Image:
    small = np.asarray(picture.convert("RGB").resize((SIDE, SIDE), Image.LANCZOS), dtype=np.float32)
    small = small / max(float(small.max()), 1e-6)
    tensor = ((small - MEAN) / SPREAD).transpose(2, 0, 1)[np.newaxis].astype(np.float32)
    drawn = session.run(None, {session.get_inputs()[0].name: tensor})[0][:, 0, :, :]
    low, high = float(drawn.min()), float(drawn.max())
    scaled = (drawn - low) / max(high - low, 1e-6)
    return Image.fromarray((np.squeeze(scaled) * 255).astype(np.uint8)).resize(picture.size, Image.LANCZOS)


def main() -> int:
    if len(sys.argv) != 4:
        sys.stderr.write("usage: cut-out-a-person.py <picture> <output.png> <model.onnx>\n")
        return 2
    source, output, model = sys.argv[1:]
    picture = Image.open(source).convert("RGB")
    session = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    cut = picture.convert("RGBA")
    cut.putalpha(mask_of(picture, session))
    cut.save(output, format="PNG")
    return 0


if __name__ == "__main__":
    sys.exit(main())
