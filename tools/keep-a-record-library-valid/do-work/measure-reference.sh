#!/bin/sh
# Measure one reference video for copy-any-format: probe, 1 FPS sheet, hook sheet, cut scan, motion rhythm, sound read.
# usage: measure.sh <video.mp4> <outdir>
set -u
[ "$#" -eq 2 ] || { echo "usage: measure.sh <video.mp4> <outdir>" >&2; exit 2; }
V="$1"; O="$2"
CIS_TOOLS="${CIS_TOOLS:-$(CDPATH= cd -P "$(dirname "$0")" && pwd)}"
HFM="${HFM:-$CIS_TOOLS/../hfm/bin/hf-media}"
VC="${VC:-}"      # the motion-tools directory this place reports; no app folder is assumed
EARSHOT_PY="${EARSHOT_PY:-python3}"
[ -f "$V" ] || { echo "measure: input file not found: $V" >&2; exit 2; }
[ -x "$HFM" ] || { echo "measure: set HFM to the installed hf-media executable" >&2; exit 2; }
[ -f "$VC/motion-rhythm.mjs" ] || { echo "measure: set VC to the installed motion-tools directory" >&2; exit 2; }
"$EARSHOT_PY" -c 'import earshot' >/dev/null 2>&1 || { echo "measure: set EARSHOT_PY to the Python environment containing earshot" >&2; exit 2; }
command -v ffprobe >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || { echo "measure: ffprobe and node must be on PATH" >&2; exit 2; }
mkdir -p "$O"
export PATH="$(dirname "$HFM"):$PATH"

# the picture track can end before the container: use the shorter of the two
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$V" </dev/null)
DV=$(ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$V" </dev/null)
case "$DV" in ''|N/A) ;; *) D=$(python3 -I -c "print(min(float('$D'),float('$DV')))") ;; esac
ffprobe -v error -show_entries format=duration:stream=codec_type,width,height,r_frame_rate -of json "$V" > "$O/probe.json"
# whole seconds strictly inside the video: a time at or past the last frame fails the whole sheet
T1=$(python3 -I -c "d=float('$D');print('['+','.join(str(float(x)) for x in range(int(d)+1) if x < d-0.25)+']')")
TH=$(python3 -I -c "d=min(5.0,float('$D'));print('['+','.join(str(round(i/6,3)) for i in range(int(d*6)))+']')")

# A long-film PNG can exceed the model transport limit. Keep the original frames,
# then make small chronological pages with native PTS labels in the existing CIS owner.
SC=$(python3 -I -c "print(0 if float('$D') > 120 else 6)")
"$HFM" evidence frames "$V" --times "$T1" --max-width 320 --sheet-columns "$SC" --out "$O/sheet-1fps" > /dev/null 2>"$O/sheet.err" &
P1=$!
"$HFM" evidence frames "$V" --times "$TH" --max-width 320 --sheet-columns 6 --out "$O/sheet-hook" > /dev/null 2>>"$O/sheet.err" &
P2=$!
"$HFM" evidence temporal-scan "$V" --out "$O/scan" > "$O/scan.json" 2>"$O/scan.err" &
P3=$!
FAILED=0
wait "$P1" || FAILED=1
wait "$P2" || FAILED=1
wait "$P3" || FAILED=1
[ "$FAILED" -eq 0 ] || exit 1
if [ "$SC" -eq 0 ]; then
  "$(dirname "$HFM")/python" -I "${TRILLION_WORKSHOP:?set TRILLION_WORKSHOP to a trillion-workshop checkout}/tools/keep-a-record-library-valid/do-work/keep_a_record_library.py" --library "$CIS_TOOLS/../.." --schema "$CIS_TOOLS/library-schema.json" frame-pages "$O/sheet-1fps/manifest.json" "$O/review-pages" --tile-width 192 --quality 35 > "$O/review-pages.json" 2>>"$O/sheet.err" || exit $?
fi
node "$VC/motion-rhythm.mjs" "$V" > "$O/rhythm.json" 2>"$O/rhythm.err" || exit $?
EARSHOT_THREADS="${EARSHOT_THREADS:-3}" "$EARSHOT_PY" -m earshot timeline "$V" > "$O/earshot-timeline.txt" 2>"$O/earshot.err" || exit $?
echo "measured $V -> $O (generated evidence only; review still required)"
