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
    inputs += ['-ss', str(m['start_s']), '-t', f'{dur:.3f}', '-i', m['file']]
    chains.append(f'[0:a]aresample=48000,aformat=channel_layouts=stereo,volume={m["gain_db"]}dB,afade=t=in:d={m["fade_in_s"]},'
                  f'afade=t=out:st={max(0, b.exit_t):.3f}:d={m["fade_out_s"]}[m0]')
    labels = ['[m0]']
    idx = 1
    for kind, t in sorted(b.sounds, key=lambda x: x[1]):
        for s in snd['events'][kind]:
            inputs += ['-i', s['file']]
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
    run(['nice', '-n', '10', 'ffmpeg', '-v', 'error', '-y', '-ss', f'{t - 0.5 / FPS:.5f}', '-i', pl['source'], '-frames:v', '1',
         '-vf', 'loop=loop=-1:size=1:start=0', '-an', '-f', 'nut', '-c:v', 'rawvideo', '-pix_fmt', 'yuv422p10le', '/tmp/narr-plate.nut'])
    run(['nice', '-n', '10', 'ffmpeg', '-v', 'error', '-y', '-stream_loop', '-1', '-r', f'{FPS_N}/{FPS_D}', '-i', '/tmp/narr-plate.nut', '-frames:v', str(b.n_frames),
         '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0', '-r', f'{FPS_N}/{FPS_D}',
         '-metadata', f'comment=S-Log3/S-Gamut3.Cine freeze of {os.path.basename(pl["source"])} frame {pl["frame"]} ({t:.4f} s), {dur:.3f} s', path])
    return path


def render_plate_graded(b, out):
