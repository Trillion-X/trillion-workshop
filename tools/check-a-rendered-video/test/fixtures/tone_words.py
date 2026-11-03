"""Made-up speech for the plan and cut speech tests: each word is a tone of its own pitch, so a stand-in reader can "hear" a wav
by finding its tones. make(words, path) writes a recording and returns each word's {text, start, end}; run as a script, it is the
reader: it prints the words of the wav given as its argument."""
import sys

import numpy as np
import soundfile as sf

PITCH = {'alpha': 300, 'bravo': 420, 'charlie': 540, 'delta': 660, 'echo': 780, 'foxtrot': 900, 'golf': 1020, 'hotel': 1140}
WORD_S, GAP_S, SR = 0.4, 0.2, 48000


def make(word_list, path, sr=SR, tail_s=0.0):
    out, times, t = [], [], GAP_S
    out.append(np.zeros(int(GAP_S * sr)))
    for w in word_list:
        n = int(WORD_S * sr)
        out.append(0.3 * np.sin(2 * np.pi * PITCH[w] * np.arange(n) / sr))
        out.append(np.zeros(int(GAP_S * sr)))
        times.append({'text': w, 'start': round(t, 3), 'end': round(t + WORD_S, 3)})
        t += WORD_S + GAP_S
    out.append(np.zeros(int(tail_s * sr)))
    sf.write(path, np.concatenate(out).astype(np.float32), sr)
    return times


def hear(path):
    y, sr = sf.read(path, dtype='float32')
    if y.ndim > 1:
        y = y.mean(axis=1)
    hop = int(0.01 * sr)
    loud = [float(np.sqrt(np.mean(y[i:i + hop] ** 2))) > 0.02 for i in range(0, len(y) - hop, hop)]
    heard, i = [], 0
    while i < len(loud):
        if not loud[i]:
            i += 1
            continue
        j = i
        while j < len(loud) and loud[j]:
            j += 1
        if j - i >= 12:   # at least 0.12 s of tone is a word; less is a clipped edge, not heard
            chunk = y[i * hop:j * hop]
            peak = np.argmax(np.abs(np.fft.rfft(chunk))) * sr / len(chunk)
            heard.append(min(PITCH, key=lambda w: abs(PITCH[w] - peak)))
        i = j
    return ' '.join(heard)


if __name__ == '__main__':
    print(hear(sys.argv[1]))
