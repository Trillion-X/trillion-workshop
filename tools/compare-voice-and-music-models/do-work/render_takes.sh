#!/bin/zsh
# render_ab.sh <line.json> <out dir>: every A/B take of one narration line, one heavy job at a time, then the same
# clean + master chain as the film (narrator/tools/voice_clean.py, showtime voice master: -16 LUFS, -1.5 dBTP, 48 kHz
# mono) and the measurements (tools/measure.py -> <out dir>/work/measure-final.jsonl, narrator/tools/gap_ticks.py).
# A take is a row of TAKES: "<work name>|<Finder name>|<command after the python>". A take already in <out dir> is
# moved to the Trash before it is made again.
set -e
LINE=${1:a}; OUT=${2:a}
HERE=${0:a:h}; NARR=${HERE:h:h}
PY=${PYTHON:-python3}
mkdir -p $OUT/work
TAKES=(
  "synthetic-2c278db27507|Narrator - 2 Kokoro fixed|$HERE/kokoro_take.py $LINE bm_lewis"
  "qwen3|Narrator - 3 Qwen3-TTS clone|$HERE/clone_take.py $LINE qwen3"
  "pocket|Narrator - 4 Pocket TTS clone|$HERE/clone_take.py $LINE pocket"
  "chatterbox|Narrator - 5 Chatterbox Turbo clone|$HERE/clone_take.py $LINE chatterbox"
  "synthetic-4ae1cb8ef177|Narrator - 6 Kokoro fixed, voice bm_george|$HERE/kokoro_take.py $LINE bm_george"
  "kokoro-bm_fable|Narrator - 7 Kokoro fixed, voice bm_fable|$HERE/kokoro_take.py $LINE bm_fable"
)
for row in $TAKES; do
  parts=("${(@s:|:)row}"); work=$OUT/work/$parts[1].wav; final="$OUT/$parts[2].wav"
  nice -n 5 $PY ${=parts[3]} $work > /dev/null
  $PY $NARR/tools/voice_clean.py $work ${work:r}-clean.wav
  [[ -e $final ]] && mv $final ~/.Trash/"${final:t:r} $(date +%Y%m%d-%H%M%S).wav"
  ${SHOWTIME:-showtime} voice master ${work:r}-clean.wav -o $final > /dev/null
  echo "made $final"
done
$PY $NARR/tools/gap_ticks.py $OUT/Narrator*.wav
$PY $HERE/measure.py $LINE $OUT/Narrator*.wav 2> $OUT/work/measure.err | grep '^{' > $OUT/work/measure-final.jsonl
echo "measured -> $OUT/work/measure-final.jsonl"
