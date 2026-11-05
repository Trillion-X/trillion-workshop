#!/usr/bin/env bash
# render_takes.sh <line.json> <out dir> [<settings record> [<film>]]: every A/B take of one narration line, one heavy job at a time, then the same
# clean + master chain for every take (the settings' clean_command, then master_command, e.g. "showtime voice master": -16 LUFS, -1.5 dBTP, 48 kHz
# mono) and the measurements (of the settings' measure_glob in <out dir>, else the takes made) (measure_takes.py -> <out dir>/work/measure-final.jsonl, then the settings' ticks_command).
# A take is a row of TAKES: "<work name>|<final name>|<script> <argument>" (say_a_line_in_kokoro.py --take-rows prints the
# settings' takes that way). A take already in <out dir> is moved to <out dir>/work/replaced/ before it is made again.
# The last line is {"result": {...}} or {"error": "what to change"}.
set -eo pipefail  # bash 3.2 (macOS) too: no mapfile, no set -u over an empty array
refuse() { local m=${1//\\/}; m=${m//\"/\'}; printf '{"error": "%s"}\n' "${m//$'\n'/ }"; exit 2; }
[[ $# -ge 2 ]] || refuse "pass <line.json> <out dir> and, if the person has one, their settings record"
[[ -f $1 ]] || refuse "$1 is not there: pass the narration line as JSON"
LINE=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); mkdir -p "$2"; OUT=$(cd "$2" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
PY=${PYTHON:-python3}
SETTINGS=${3:-}; FILM=${4:-}
SET=(); [[ -n $SETTINGS ]] && SET=(--settings-record "$SETTINGS"); [[ -n $FILM ]] && SET+=(--film "$FILM")
mkdir -p "$OUT/work"
rows=$($PY -I "$HERE/say_a_line_in_kokoro.py" --take-rows "${SETTINGS:--}" "${SET[@]:2}") || refuse "the settings' takes cannot be read: $rows"
chain=$($PY -I "$HERE/say_a_line_in_kokoro.py" --chain "${SETTINGS:--}" "${SET[@]:2}") || refuse "the settings' clean, master and ticks commands cannot be read: $chain"
CLEAN=$(sed -n 1p <<<"$chain"); MASTER=$(sed -n 2p <<<"$chain"); TICKS=$(sed -n 3p <<<"$chain"); GLOB=$(sed -n 4p <<<"$chain")
if [[ -n $MASTER ]] && ! command -v "${MASTER%% *}" >/dev/null; then refuse "${MASTER%% *} is not installed: install it, or set master_command"; fi
TAKES=(); while IFS= read -r row; do [[ -n $row ]] && TAKES+=("$row"); done <<<"$rows"
made=()
for row in "${TAKES[@]}"; do
  IFS='|' read -r w f cmd <<<"$row"; work=$OUT/work/$w.wav; final="$OUT/$f.wav"
  read -r script arg <<<"$cmd"
  said=$(nice -n 5 $PY -I "$HERE/$script" "$LINE" "$arg" "$work" "${SET[@]}") || refuse "take $w was not made: $(tail -n 1 <<<"$said" | tr -d '"')"
  if [[ -n $CLEAN ]]; then $CLEAN "$work" "${work%.wav}-clean.wav"; else cp "$work" "${work%.wav}-clean.wav"; fi
  [[ -e $final ]] && mkdir -p "$OUT/work/replaced" && mv "$final" "$OUT/work/replaced/$(basename "${final%.wav}") $(date +%Y%m%d-%H%M%S).wav"
  if [[ -n $MASTER ]]; then $MASTER "${work%.wav}-clean.wav" -o "$final" > /dev/null; else cp "${work%.wav}-clean.wav" "$final"; fi
  echo "made $final" >&2
  made+=("$final")
done
# The takes measured: every file of measure_glob in <out dir> when the settings name one (a take kept from before, too), else those made.
if [[ -n $GLOB ]]; then shopt -s nullglob; made=("$OUT"/$GLOB); shopt -u nullglob; fi
if [[ -n $TICKS ]]; then $TICKS "${made[@]}" >&2; fi
measured=$($PY -I "$HERE/measure_takes.py" "$LINE" "${made[@]}" "${SET[@]}" 2> "$OUT/work/measure.err") || refuse "the measure refused: $(tail -n 1 <<<"$measured" | tr -d '"')"
grep '^{"take"' <<<"$measured" > "$OUT/work/measure-final.jsonl"
echo "measured -> $OUT/work/measure-final.jsonl" >&2
printf '{"result": {"takes": %s, "measures": "%s"}}\n' "${#made[@]}" "$OUT/work/measure-final.jsonl"
