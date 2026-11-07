def main():
    source, out = sys.argv[1], sys.argv[2]
    start = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    window = ['-ss', f'{start:.2f}', '-to', f'{float(sys.argv[4]):.2f}'] if len(sys.argv) > 4 else []
    with tempfile.TemporaryDirectory() as tmp:
        wav = f'{tmp}/a.wav'
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', *window, '-i', source,
                        '-vn', '-ac', '1', '-ar', '16000', wav], check=True)
        result = mlx_whisper.transcribe(wav, path_or_hf_repo=MODEL, language='en', word_timestamps=True)
    words = [{'text': w['word'].strip(), 'start': round(w['start'] + start, 2), 'end': round(w['end'] + start, 2)}
             for s in result['segments'] for w in s.get('words', [])]
    pathlib.Path(out).write_text(json.dumps({'source': source, 'timing': 'word', 'words': words}))
    print(f'{len(words)} words -> {out}')
