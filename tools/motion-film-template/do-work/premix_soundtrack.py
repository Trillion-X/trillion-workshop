inputs = ['-i', str(MUSIC)]
filters = [f"[0:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:{DUR:.3f},asetpts=PTS-STARTPTS,"
           f"volume={BED}dB,afade=t=in:d=0.3,afade=t=out:st={DUR - FADE_OUT:.3f}:d={FADE_OUT}[m]"]
labels = ['[m]']
for j, (t, name, g) in enumerate(CUES):
    inputs += ['-i', str(PAL / f'{name}.wav')]
    ms = int(max(0, t) * 1000)
    filters.append(f"[{j + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume={g}dB,adelay={ms}|{ms}[s{j}]")
    labels.append(f'[s{j}]')
filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,atrim=0:{DUR}[pre]")

out = FILM / 'assets/soundtrack.wav'
raw = FILM / 'audio/premix-raw.wav'
subprocess.run(['ffmpeg', '-nostdin', '-y', '-v', 'error', *inputs, '-filter_complex', ';'.join(filters), '-map', '[pre]',
                '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', str(raw)], check=True)

def measure(extra=''):
    r = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', str(raw), '-af', extra + 'loudnorm=I=-14.5:TP=-1.5:LRA=20:print_format=json',
                        '-f', 'null', '-'], capture_output=True, text=True)
    return json.loads(re.findall(r'\{[^{}]*\}', r.stderr)[-1])

# Loudness: two passes, linear (one gain), with a true-peak limiter first so linear mode is never refused.
m = measure()
gain = -14.5 - float(m['input_i'])
lim = f"volume={gain:.2f}dB,alimiter=limit={10 ** (-1.9 / 20):.4f}:attack=1:release=60:level=false,volume={-gain:.2f}dB,"
m2 = measure(lim)
af = (lim + f"loudnorm=I=-14.5:TP=-1.5:LRA=20:linear=true:measured_I={m2['input_i']}:measured_TP={m2['input_tp']}:"
      f"measured_LRA={m2['input_lra']}:measured_thresh={m2['input_thresh']}:offset={m2['target_offset']}:print_format=json")
r = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-y', '-i', str(raw), '-af', af, '-ar', '48000', '-ac', '2', str(out)],
                   capture_output=True, text=True, check=True)
res = json.loads(re.findall(r'\{[^{}]*\}', r.stderr)[-1])
print('loudnorm', res['normalization_type'], 'in', m['input_i'], 'LUFS -> out', res['output_i'], 'LUFS, TP', res['output_tp'], 'LRA', res['output_lra'])
subprocess.run(['trash', str(raw)], check=False)
print('wrote', out, f'{DUR} s,', len(CUES), 'effects from', len(set(c[1] for c in CUES)), 'recordings')
