"""A correction insert: the overlay of one shot and what an editor needs to cut it into a film, each a file of its own:

  <id>-overlay-prores4444.mov       the overlay with alpha (cut-out, paper, type, motion, subtitles)
  <id>-narrator.wav                 the narrator's voice, padded so 0 s is the overlay's first frame
  <id>-sfx-music.wav                the music bed and the sound effects, with the same alignment
  <id>-plate-slog3-prores422hq.mov  the freeze plate in the camera's S-Log3 (no grade), kept for reference
  <id>-plate-graded-prores422hq.mov the freeze plate from the person's graded export: it goes above their adjustment layer
  <id>-preview.mp4                  3 s of the graded cut, the insert, 3 s after
  <id>-timeline.json                every element and sound with its resolved time

A shot is a spec (overlay/build.py) with the insert's own keys: plate {source, frame}, graded_frame {export, cut_frame},
cut_insert_s, and optionally preview_before_end_s / preview_after_start_s (null: the film ends with the insert). A shot
without duration_s lasts until its exit's light leak and its last word have finished, as a correction always did.

Imported after look.install(), like build. Ported from a film's narrator correction renderer (render_correction.py
lines 730-883 and its build's duration rule)."""
import json
import math
import os
import shutil
import subprocess
import sys

from PIL import Image

from overlay import look, stage

R = look.R
P = look.at_root
W, H = stage.W, stage.H
FPS_N, FPS_D = stage.FPS_N, stage.FPS_D
FPS = FPS_N / FPS_D
TOOLS = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
CHECK_CLAIMS = os.path.join(TOOLS, 'check-every-claim-against-its-facts-and-sources', 'do-work', 'check_claims.py')


# ---------- outputs ----------
def run(cmd, **kw):
    print('+', ' '.join(str(c) for c in cmd)[:300], flush=True)
    subprocess.run(cmd, check=True, **kw)


def render_overlay(b, out):
    path = os.path.join(out, f'{b.id}-overlay-prores4444.mov')
    p = subprocess.Popen(['nice', '-n', '10', 'ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{W}x{H}',
                          '-r', f'{FPS_N}/{FPS_D}', '-i', '-', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le',
                          '-alpha_bits', '16', '-vendor', 'apl0', '-threads', '4',
                          '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', path], stdin=subprocess.PIPE)
    for n in range(b.n_frames):
        p.stdin.write(b.frame(n).tobytes())
        if n % 48 == 0:
            print(f'  frame {n}/{b.n_frames}', flush=True)
    p.stdin.close()
    if p.wait():
        raise SystemExit('ffmpeg overlay encode failed')
    return path


def render_audio(b, out):
    snd = R['sound']
    dur = b.n_frames / FPS
    voice = os.path.join(out, f'{b.id}-narrator.wav')
    d_ms = int(b.words.t0 * 1000)
    run(['ffmpeg', '-v', 'error', '-y', '-i', P(b.shot['voice']['wav']), '-af',
         f'aresample=48000,aformat=channel_layouts=stereo,adelay={d_ms}|{d_ms},apad,atrim=0:{dur:.4f},volume={snd["voice_gain_db"]}dB',
         '-c:a', 'pcm_s24le', voice])
    inputs, chains = [], []
    m = snd['music']
    inputs +=['-ss', str(m['start_s']), '-t', f'{dur:.3f}', '-i', look.asset(m['file'])]
    chains.append(f'[0:a]aresample=48000,aformat=channel_layouts=stereo,volume={m["gain_db"]}dB,afade=t=in:d={m["fade_in_s"]},'
                  f'afade=t=out:st={max(0, b.exit_t):.3f}:d={m["fade_out_s"]}[m0]')
    labels = ['[m0]']
    idx = 1
    for kind, t in sorted(b.sounds, key=lambda x: x[1]):
        if kind not in snd['events']:
            raise SystemExit(f'{b.id} plays the sound `{kind}`, which the settings\' sound table (recipe.sound.events and sound_layers) does not hold; add it')
        for s in snd['events'][kind]:
            inputs += ['-i', look.asset(s['file'])]
            ms = max(0, int(t * 1000))
            trim = f'atrim=0:{s["max_s"]},afade=t=out:st={max(0.0, s["max_s"] - 0.08)}:d=0.08,' if s.get('max_s') else ''
            chains.append(f'[{idx}:a]aresample=48000,aformat=channel_layouts=stereo,{trim}volume={s["gain_db"]}dB,adelay={ms}|{ms}[s{idx}]')
            labels.append(f'[s{idx}]')
            idx += 1
    graph = ';'.join(chains) + ';' + ''.join(labels) + f'amix=inputs={len(labels)}:normalize=0:dropout_transition=0,volume={snd["stem_gain_db"]}dB,apad,atrim=0:{dur:.4f}[out]'
    stem = os.path.join(out, f'{b.id}-sfx-music.wav')
    run(['ffmpeg', '-v', 'error', '-y'] + inputs + ['-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_s24le', stem])
    return voice, stem


def render_plate(b, out):
    pl = b.shot['plate']
    t = pl['frame'] * FPS_D / FPS_N
    path = os.path.join(out, f'{b.id}-plate-slog3-prores422hq.mov')
    dur = b.n_frames / FPS
    still = os.path.join(out, f'{b.id}-plate.nut')  # the one frame, decoded once, in the shot's own folder so renders never share it
    run(['nice', '-n', '10', 'ffmpeg', '-v', 'error', '-y', '-ss', f'{t - 0.5 / FPS:.5f}', '-i', P(pl['source']), '-frames:v', '1',
         '-vf', 'loop=loop=-1:size=1:start=0', '-an', '-f', 'nut', '-c:v', 'rawvideo', '-pix_fmt', 'yuv422p10le', still])
    run(['nice', '-n', '10', 'ffmpeg', '-v', 'error', '-y', '-stream_loop', '-1', '-r', f'{FPS_N}/{FPS_D}', '-i', still, '-frames:v', str(b.n_frames),
         '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0', '-r', f'{FPS_N}/{FPS_D}',
         '-metadata', f'comment=S-Log3/S-Gamut3.Cine freeze of {os.path.basename(pl["source"])} frame {pl["frame"]} ({t:.4f} s), {dur:.3f} s', path])
    os.remove(still)
    return path


def render_plate_graded(b, out):
    """The freeze frame taken from the person's graded export, held for the insert: it sits above their adjustment layer,
    so the match never depends on an editor's colour setting."""
    g = b.shot['graded_frame']
    tf = g['cut_frame'] * FPS_D / FPS_N
    path = os.path.join(out, f'{b.id}-plate-graded-prores422hq.mov')
    still = os.path.join(out, f'{b.id}-plate-graded.nut')
    run(['nice', '-n', '10', 'ffmpeg', '-v', 'error', '-y', '-ss', f'{tf - 0.5 / FPS:.5f}', '-i', P(g['export']), '-frames:v', '1',
         '-vf', 'scale=1920:1080:flags=lanczos', '-an', '-f', 'nut', '-c:v', 'rawvideo', '-pix_fmt', 'yuv422p10le', still])
    run(['nice', '-n', '10', 'ffmpeg', '-v', 'error', '-y', '-stream_loop', '-1', '-r', f'{FPS_N}/{FPS_D}', '-i', still,
         '-frames:v', str(b.n_frames), '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0',
         '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-r', f'{FPS_N}/{FPS_D}',
         '-metadata', f'comment=graded freeze of {os.path.basename(g["export"])} frame {g["cut_frame"]} ({tf:.4f} s), {b.n_frames / FPS:.3f} s', path])
    os.remove(still)
    return path


def render_preview(b, out, overlay, voice, stem, quick=False, encoder='h264_videotoolbox'):
    """3 s of the graded export, the insert, 3 s after. overlay=None pipes the overlay frames straight in (quick previews).
    encoder: this computer's H.264 encoder (h264_videotoolbox on a Mac, libx264 elsewhere)."""
    g = b.shot['graded_frame']
    exp = P(g['export'])
    tin = b.shot['cut_insert_s']
    tf = g['cut_frame'] * FPS_D / FPS_N
    before_end = b.shot.get('preview_before_end_s', tin)  # export second where the shot before the insert ends
    after_start = b.shot.get('preview_after_start_s', tin)  # export second where the shot after the insert starts; null = the film ends
    path = os.path.join(out, f'{b.id}-preview.mp4')
    post = after_start is not None
    sz = '960:540' if quick else '1920:1080'
    fc = (f'[0:v]scale={sz},setpts=PTS-STARTPTS,format=yuv420p[pre];'
          f'[1:v]scale={sz},loop=loop=-1:size=1:start=0,trim=end_frame={b.n_frames},setpts=N/FRAME_RATE/TB[frz];'
          f'[2:v]scale={sz},setpts=PTS-STARTPTS[ov];[frz][ov]overlay=format=auto,format=yuv420p[mid];'
          '[0:a]asetpts=PTS-STARTPTS,aresample=48000[a0];[3:a][4:a]amix=inputs=2:normalize=0,aresample=48000[a1];')
    fc += (f'[5:v]scale={sz},setpts=PTS-STARTPTS,format=yuv420p[post];[5:a]asetpts=PTS-STARTPTS,aresample=48000[a2];'
           '[pre][a0][mid][a1][post][a2]concat=n=3:v=1:a=1[v][a]') if post else '[pre][a0][mid][a1]concat=n=2:v=1:a=1[v][a]'
    tail = ['-ss', f'{after_start:.4f}', '-t', '3', '-i', exp] if post else []
    ov_in = ['-i', overlay] if overlay else ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{W}x{H}', '-r', f'{FPS_N}/{FPS_D}', '-i', 'pipe:0']
    cmd = (['nice', '-n', '10', 'ffmpeg', '-v', 'error', '-y',
            '-ss', f'{before_end - 3:.4f}', '-t', '3', '-i', exp,
            '-ss', f'{tf + 0.5 / FPS:.4f}', '-r', f'{FPS_N}/{FPS_D}', '-i', exp] + ov_in + ['-i', voice, '-i', stem] + tail +
           ['-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-r', f'{FPS_N}/{FPS_D}',
            '-c:v', encoder, '-b:v', '5M' if quick else '16M', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', path])
    if overlay:
        run(cmd)
        return path
    print('+', ' '.join(cmd)[:300], flush=True)
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for n in range(b.n_frames):
        p.stdin.write(b.frame(n).tobytes())
    p.stdin.close()
    if p.wait():
        raise SystemExit('ffmpeg quick preview failed')
    return path


# ---------- the claim check before a render ----------
def check_claims(sid, claim_check):
    """(ok, report) for one shot from tool:check-every-claim-against-its-facts-and-sources. claim_check is that tool's
    request without `shots` (lane_dir, sources, frames_root, world_dir, hedge_phrases, settings_record...), or
    {"skip": "<why>"} for a shot that makes no claim (the answer keeps the reason)."""
    if 'skip' in claim_check:
        return True, [f'{sid}: claim check skipped: {claim_check["skip"]}']
    request = {k: v for k, v in claim_check.items() if k != 'shots'}
    request.update(shots=[sid], quiet=True)
    p = subprocess.run([sys.executable, '-I', CHECK_CLAIMS], input=json.dumps(request), capture_output=True, text=True)
    lines = [ln for ln in p.stdout.splitlines() if ln.strip()]
    try:
        answer = json.loads(lines[-1])
    except (IndexError, json.JSONDecodeError):
        raise SystemExit(f'{sid}: the claim check answered nothing readable (exit {p.returncode}): {p.stderr.strip()[-400:]}')
    if 'error' in answer:
        raise SystemExit(f'{sid}: the claim check refused its request: {answer["error"]}')
    res = answer['result']
    report = list(res.get('world', {}).get('lines', []))
    seen = set(report)
    for shot in res['shots']:  # a shot stopped by the world's own check repeats the world's lines: kept once
        report += [ln for ln in shot.get('lines', []) if ln not in seen]
    return bool(res['ok']), report


# ---------- one insert ----------
def render_insert(spec, out, mode='full', stills=None, encoder='h264_videotoolbox', claim_check=None, copy_to=None):
    """Render one shot's insert into out (the shot's own folder). mode: full (overlay, sound, plates, preview), quick (the
    sound and a 540p preview with the overlay piped in, no ProRes files) or audio_only (the sound and the preview against
    the overlay already in out). stills: seconds; writes those frames over the shot's cut-out picture instead.
    copy_to: a file the preview is copied to (a picker folder). Returns what was written."""
    global W, H
    from overlay.build import Build
    sid = spec['id']
    ok, report = check_claims(sid, claim_check or {'skip': 'no claim check was given'})
    print('\n'.join(report))
    if not ok:
        raise SystemExit(f'{sid}: refused, the claim check fails (tool:check-every-claim-against-its-facts-and-sources, shot {sid})')
    from_exit = spec.get('duration_s') is None  # a correction lasts until its exit has left and its last word is said
    stage.W, stage.H = spec.get('canvas', look.SECTIONS['frame'])
    W, H = stage.W, stage.H
    look.FOLDERS['out'] = out
    b = Build(dict(spec, duration_s=0.0) if from_exit else spec)
    b.build()
    if b.exit_t is None or b.exit_t >= 1e9:
        raise SystemExit(f'{sid}: shot has no exit event')
    if from_exit:
        b.duration = max(b.exit_t + R['exit']['leak_s'], b.words.end()) + 0.05
        b.n_frames = int(math.ceil(b.duration * FPS))
    R['sound']['events'].update(b.extra_sounds)
    os.makedirs(out, exist_ok=True)
    tl = {'id': sid, 'duration_s': round(b.n_frames / FPS, 4), 'frames': b.n_frames, 'exit_s': round(b.exit_t, 3),
          'voice_start_s': b.words.t0, 'elements': b.log, 'sounds': [{'kind': k, 't': round(t, 3)} for k, t in sorted(b.sounds, key=lambda x: x[1])]}
    timeline = os.path.join(out, f'{sid}-timeline.json')
    json.dump(tl, open(timeline, 'w'), indent=1)
    answer = {'id': sid, 'frames': b.n_frames, 'duration_s': tl['duration_s'], 'timeline': timeline, 'claim_check': report}
    if stills:
        written = []
        for s in stills:
            n = int(float(s) * FPS)
            im = b.frame(n)
            bg = Image.open(P(b.shot['cutout']['image'])).convert('RGBA')
            bg.alpha_composite(im)
            written.append(os.path.join(out, f'still-{float(s):05.2f}.jpg'))
            bg.convert('RGB').resize((1920, 1080)).save(written[-1], quality=88)
        answer['stills'] = written
        return answer
    if mode == 'quick':
        voice, stem = render_audio(b, out)
        preview = render_preview(b, out, None, voice, stem, quick=True, encoder=encoder)
        answer.update(narrator=voice, sfx_music=stem, preview=preview)
    else:
        overlay = os.path.join(out, f'{sid}-overlay-prores4444.mov')
        if mode != 'audio_only':
            overlay = render_overlay(b, out)
        elif not os.path.isfile(overlay):
            raise SystemExit(f'{sid}: audio_only needs the overlay a full render wrote at {overlay}; render the shot with mode full first')
        voice, stem = render_audio(b, out)
        answer.update(overlay=overlay, narrator=voice, sfx_music=stem)
        if mode != 'audio_only':
            answer.update(plate=render_plate(b, out), plate_graded=render_plate_graded(b, out))
        answer['preview'] = render_preview(b, out, overlay, voice, stem, encoder=encoder)
    if copy_to:
        os.makedirs(os.path.dirname(copy_to) or '.', exist_ok=True)
        shutil.copyfile(answer['preview'], copy_to)
        answer['copied_to'] = copy_to
        print(f'done {sid} -> {copy_to}', flush=True)
    return answer
