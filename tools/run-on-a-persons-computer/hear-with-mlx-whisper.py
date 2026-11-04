# computer/hear-with-mlx-whisper.py
#
# Purpose: hear one recording on this Mac with mlx-whisper (on the Mac's own chip, about 25 times faster than the
# hosted hearing and never stopped by a service restart) and print the words as one JSON transcript value:
#   { text, segments: [{ start, end, text, words: [{ word, start, end }] }], language, heard_whole: true }
# It is one of the `hearing` rows in computer-sources.json; keep-drive-files.mjs runs it beside a recording's upload.
#
#   python3 hear-with-mlx-whisper.py <recording> <model> [<language> [<prompt>]]
#       <language> (such as "en") is the language the listening session already heard; empty or left out, it is detected.
#       <prompt> is words that may come up (names, product words: computer/dictation.mjs biasPrompt); empty or left out, none.
#   python3 hear-with-mlx-whisper.py serve <socket> <idle_seconds>
#       stays running with the model loaded (computer/resident.py) and answers { "argv": [<this file>, <recording>,
#       <model>, <language>, <prompt>] } with { "ok": true, "value": <the transcript value> }, so a listener hearing a piece every half
#       minute loads the model once instead of starting Python and loading it for every piece. The hearing row's
#       `resident` (computer-sources.json) says its socket and how long it waits idle; keep-drive-files.mjs hearWith
#       starts it when nothing answers.
#
# Invariants:
#   1. Read only: the recording is read in place and nothing is written anywhere; the words go to stdout.
#   2. Nothing is made up. Silence makes the model repeat a stock phrase ("Thank you."), and such segments carry a high
#      chance of no speech or a high compression ratio, so they are dropped; a recording left with nothing, or with one
#      line said over and over, is answered with empty words, which still says it was heard whole. A short recording
#      of one or two real sentences keeps its words. A piece guessed afresh can be "detected" as another language and
#      heard as that language's stock phrase ("다음 영상에서 만나요", see you in the next video), so a listening session
#      hands its language in; the model also skips silence around a likely hallucination (HALLUCINATION_SILENCE_SECONDS)
#      and a segment it was not confident of (average log probability under LEAST_AVG_LOGPROB) is dropped.
#   3. Served or run once, a recording is heard the same way and answered with the same value.
#
# AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import json
import sys

import mlx_whisper

from resident import answer_argv, serve

NO_SPEECH_AT_LEAST = 0.6
REPEATING_AT_LEAST = 2.4
LEAST_AVG_LOGPROB = -1.0
HALLUCINATION_SILENCE_SECONDS = 2.0


def spoken(segment):
    return (segment.get('no_speech_prob', 0) < NO_SPEECH_AT_LEAST and segment.get('compression_ratio', 0) < REPEATING_AT_LEAST
            and segment.get('avg_logprob', 0) >= LEAST_AVG_LOGPROB)


def hear(recording, model, language='', prompt=''):
    known = {'language': language} if language else {}
    if prompt:
        known['initial_prompt'] = prompt
    heard = mlx_whisper.transcribe(recording, path_or_hf_repo=model, word_timestamps=True, condition_on_previous_text=False,
                                   hallucination_silence_threshold=HALLUCINATION_SILENCE_SECONDS, **known)
    segments = [{
        'start': segment['start'], 'end': segment['end'], 'text': segment['text'].strip(),
        'words': [{'word': word['word'], 'start': word['start'], 'end': word['end']} for word in segment.get('words', [])],
    } for segment in heard['segments'] if spoken(segment)]
    lines = [segment['text'].lower() for segment in segments]
    if len(lines) > 1 and len(set(lines)) == 1:
        segments = []
    text = ' '.join(segment['text'] for segment in segments).strip()
    return {'text': text, 'segments': segments, 'language': heard.get('language'), 'heard_whole': True}


def main(argv):
    return hear(argv[0], argv[1], argv[2] if len(argv) > 2 else '', argv[3] if len(argv) > 3 else '')


if __name__ == '__main__':
    if sys.argv[1] == 'serve':
        serve(sys.argv[2], float(sys.argv[3]), answer_argv(main))
    else:
        json.dump(main(sys.argv[1:]), sys.stdout)
