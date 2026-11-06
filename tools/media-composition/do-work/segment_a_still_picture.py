"""The still-picture mode of segment-person-matte.py: a grayscale mask (white = subject) of each picture, by a named rembg
model, written beside it as <picture>.mask-<model>.png. The mask is rembg's own (only_mask, no post-process), so its soft
edge is kept for a cut-out sticker to feather.

Usage: segment-person-matte.py --still <model> <picture.png> [<picture.png> ...]
  model: a rembg model name, e.g. birefnet-portrait (a person, fine hair edge) or u2net_human_seg. It downloads once on
         first use (onnxruntime).
Prints `ok <picture>` per picture written; exits 2 on a wrong call. Ported from a film's narrator segment script."""
import os
import sys


def mask_path(src, model):
    """<stem>.mask-<model>.png beside the picture (only the last .png is replaced; any other picture keeps its name)."""
    stem = src[:-4] if src.lower().endswith('.png') else os.path.splitext(src)[0]
    return f'{stem}.mask-{model}.png'


def main():
    """sys.argv: [program, model, picture, ...] (segment-person-matte.py --still hands its own arguments on this way)."""
    if len(sys.argv) < 3:
        sys.stderr.write('usage: segment-person-matte.py --still <model> <picture.png> [<picture.png> ...]\n')
        return 2
    from rembg import remove, new_session
    from PIL import Image
    model=sys.argv[1]; s=new_session(model)
    for src in sys.argv[2:]:
        im=Image.open(src).convert('RGB')
        m=remove(im,session=s,only_mask=True,post_process_mask=False)
        m.save(mask_path(src, model))
        print('ok',src,flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
