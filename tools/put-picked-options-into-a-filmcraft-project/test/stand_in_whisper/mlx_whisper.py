"""A stand-in mlx_whisper for the review-pack test: the same made-up words for any recording. Made up."""


def transcribe(audio, path_or_hf_repo=None, **options):
    words = [('Made', 0.2), ('up', 0.5), ('words.', 0.8), ('A', 1.4), ('question?', 1.6), ('No', 2.2), ('end', 2.5)]
    return {'text': ' '.join(w for w, _ in words), 'segments': [{'words': [{'word': ' ' + w, 'start': t, 'end': t + 0.2} for w, t in words]}]}
