"""Local point-prompted SAM2 video masks. Frames never leave this process.

The caller owns process lifetime, output directory, and final adoption. Model
weights must already exist locally; inference never downloads or calls an API.
"""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'

def run():
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--start', type=float, required=True)
    parser.add_argument('--end', type=float, required=True)
    parser.add_argument('--time', type=float, required=True)
    parser.add_argument('--points', required=True)
    parser.add_argument('--fps', type=int, default=12)
    parser.add_argument('--model', required=True)
    parser.add_argument('--device', default='mps')
    args = parser.parse_args()
    points = json.loads(args.points)
    if not (0 <= args.start <= args.time < args.end and args.end-args.start <= 30 and 1 <= args.fps <= 30):
        raise ValueError('Choose a mask range up to 30 seconds containing the selected frame.')
    if not isinstance(points, list) or not 1 <= len(points) <= 32 or not any(p.get('include') is True for p in points):
        raise ValueError('Select at least one point inside the object.')
    for point in points:
        if not all(isinstance(point.get(k), (int, float)) and math.isfinite(point[k]) and 0 <= point[k] <= 1 for k in ['x','y']) or not isinstance(point.get('include'), bool):
            raise ValueError('Choose points inside the picture.')
    root = Path(args.output)
    if root.exists():
        raise ValueError('The output folder must be new: choose a folder that does not exist yet.')
    root.mkdir(parents=True)
    frames_dir, masks_dir, previews_dir = [root/name for name in ['source-frames','masks','preview']]
    for folder in [frames_dir, masks_dir, previews_dir]:
        folder.mkdir()
    subprocess.run(['ffmpeg','-v','error','-ss',str(args.start),'-i',args.video,'-t',str(args.end-args.start),'-vf',f'fps={args.fps},scale=720:720:force_original_aspect_ratio=decrease','-start_number','0',str(frames_dir/'%05d.png')],check=True)
    import torch
    import numpy as np
    from PIL import Image
    from transformers import Sam2VideoModel, Sam2VideoProcessor
    files = sorted(frames_dir.glob('*.png'))
    if not files or len(files) > 901:
        raise ValueError('The selected video range could not be decoded.')
    frames = [Image.open(file).convert('RGB') for file in files]
    width, height = frames[0].size
    selected = min(len(frames)-1, max(0, round((args.time-args.start)*args.fps)))
    processor = Sam2VideoProcessor.from_pretrained(args.model, local_files_only=True)
    model = Sam2VideoModel.from_pretrained(args.model, local_files_only=True).to(args.device).eval()
    session = processor.init_video_session(video=frames,inference_device=args.device,dtype=torch.float32)
    processor.add_inputs_to_inference_session(inference_session=session,frame_idx=selected,obj_ids=1,input_points=[[[[p['x']*width,p['y']*height] for p in points]]],input_labels=[[[int(p['include']) for p in points]]],original_size=(height,width))
    counts = {}
    with torch.inference_mode():
        model(inference_session=session,frame_idx=selected)
        for reverse in [False, True]:
            for result in model.propagate_in_video_iterator(session,start_frame_idx=selected,reverse=reverse):
                mask=processor.post_process_masks([result.pred_masks],original_sizes=[[height,width]],binarize=True)[0][0,0].cpu().numpy().astype('uint8')*255
                index = int(result.frame_idx)
                Image.fromarray(mask).save(masks_dir/f'{index:05d}.png')
                rgba=np.full((height,width,4),255,dtype='uint8');rgba[:,:,3]=mask
                Image.fromarray(rgba).save(previews_dir/f'{index:05d}.png')
                counts[index]=int((mask>0).sum())
    if len(counts) != len(frames) or not counts.get(selected):
        raise ValueError('No object was found at the selected points. Choose another point or add a point inside the object.')
    subprocess.run(['ffmpeg','-v','error','-framerate',str(args.fps),'-i',str(masks_dir/'%05d.png'),'-c:v','ffv1','-pix_fmt','gray',str(root/'mask.mkv')],check=True)
    result={'start':args.start,'end':args.end,'fps':args.fps,'frames':len(frames),'width':width,'height':height,'selected_frame':selected,'pixels':[counts[i] for i in range(len(frames))],'model':args.model}
    (root/'result.json').write_text(json.dumps(result))
    # Only disposable frames created by this invocation are removed.
    for file in files:
        file.unlink()
    frames_dir.rmdir()
    print(json.dumps({"result": result}))

def main():
    try:
        run()
    except (ValueError, subprocess.CalledProcessError) as error:
        print(json.dumps({'error': str(error)}))
        raise SystemExit(2)


if __name__ == '__main__':
    main()
