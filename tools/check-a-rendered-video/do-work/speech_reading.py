"""Hearing speech for the plan and cut checks (check_plan_cuts.py, check_cut_speech.py): a reader that turns a wav into text, the
words of a text as the checks compare them, and a stretch of a media file cut out as a 16 kHz mono wav.

The reader is the person's choice: `--reader '["cmd", "arg", ...]'` runs that command with the wav added as its last argument and
reads the text it prints; without it, mlx-whisper (Apple silicon) reads with `--model` and `--language`.
"""
import json
import re
import subprocess

DEFAULT_MODEL = 'mlx-community/whisper-large-v3-turbo'


def add_reader_options(ap):
    ap.add_argument('--reader', help='a JSON list: the command that reads a wav (given as its last argument) and prints its words')
    ap.add_argument('--model', default=DEFAULT_MODEL, help=f'the mlx-whisper model when no --reader is given (default {DEFAULT_MODEL})')
    ap.add_argument('--language', help='the language mlx-whisper reads in (default: it detects)')


def reader_of(args):
    """a function wav path -> the text heard in it"""
    if args.reader:
        argv = json.loads(args.reader)
        if not isinstance(argv, list) or not argv:
            raise SystemExit('--reader is a JSON list: the command and its arguments, the wav is added last')

        def read(wav):
            r = subprocess.run([*map(str, argv), str(wav)], capture_output=True, text=True)
            if r.returncode:
                raise SystemExit(f'the reader {argv[0]} failed on {wav}: {r.stderr.strip()[-400:]}')
            return r.stdout.strip()
        return read
    try:
        import mlx_whisper
    except ImportError as e:
        raise SystemExit('no reader: install mlx-whisper (Apple silicon) or give --reader, a command that prints the words of a wav') from e

    def read(wav):
        options = {'language': args.language} if args.language else {}
        return mlx_whisper.transcribe(str(wav), path_or_hf_repo=args.model, **options)['text'].strip()
    return read


def words(text):
    """the words of a text as the checks compare them: lower case, a possessive 's dropped, hyphens split, punctuation gone"""
    return re.sub(r"[^a-z0-9' ]", ' ', re.sub(r"'s\b", '', text.lower().replace('’', "'")).replace('-', ' ')).split()


def cut_audio(source, start, end, out):
    """source seconds start..end of a media file as a 16 kHz mono wav"""
    subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-ss', f'{start:.3f}', '-to', f'{end:.3f}', '-i', str(source),
                    '-vn', '-ac', '1', '-ar', '16000', str(out)], check=True)
