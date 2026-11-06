#!/bin/sh
# Measure one reference video: probe, 1 FPS sheet, hook sheet, cut scan, motion rhythm, sound read.
# usage: measure-reference.sh <video.mp4> <outdir> --hf-media P --motion-tools DIR --earshot-python P
#          [--ffprobe P] [--node P] [--pages-python P] [--earshot-threads N]
# Every program is an argument (never a default pointing at a sibling folder); ffprobe, node and the pages Python default to the ones
# on PATH. The last line on standard output is one JSON object: { measured, video, out, duration_s, files } or { measured: false, failed }.
# Exit 0 measured, 1 a step failed, 2 a usage error or a missing program. It records evidence; review is still required.
set -u
usage() { echo "usage: measure-reference.sh <video.mp4> <outdir> --hf-media P --motion-tools DIR --earshot-python P [--ffprobe P] [--node P] [--pages-python P] [--earshot-threads N]" >&2; exit 2; }
[ "$#" -ge 2 ] || usage
V="$1"; O="$2"; shift 2
HFM=""; VC=""; EARSHOT_PY=""; FFPROBE=ffprobe; NODE=node; PAGES_PY=python3; THREADS=3
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --hf-media) HFM="$2" ;;
    --motion-tools) VC="$2" ;;
    --earshot-python) EARSHOT_PY="$2" ;;
    --ffprobe) FFPROBE="$2" ;;
    --node) NODE="$2" ;;
    --pages-python) PAGES_PY="$2" ;;
    --earshot-threads) THREADS="$2" ;;
    *) usage ;;
  esac
  shift 2
done
HERE="$(CDPATH= cd -P "$(dirname "$0")" && pwd)"
[ -f "$V" ] || { echo "measure: input file not found: $V" >&2; exit 2; }
[ -n "$HFM" ] && [ -x "$HFM" ] || { echo "measure: give --hf-media, the installed hf-media executable" >&2; exit 2; }
[ -n "$VC" ] && [ -f "$VC/motion-rhythm.mjs" ] || { echo "measure: give --motion-tools, the folder holding motion-rhythm.mjs" >&2; exit 2; }
[ -n "$EARSHOT_PY" ] && "$EARSHOT_PY" -c 'import earshot' >/dev/null 2>&1 || { echo "measure: give --earshot-python, a Python environment containing earshot" >&2; exit 2; }
command -v "$FFPROBE" >/dev/null 2>&1 && command -v "$NODE" >/dev/null 2>&1 || { echo "measure: ffprobe and node must be on PATH or given with --ffprobe and --node" >&2; exit 2; }
mkdir -p "$O"
export PATH="$(dirname "$HFM"):$PATH"
said() {  # the JSON line: measured (true/false), then what failed
  python3 -I -c 'import json, sys; v, o, d, ok, failed = sys.argv[1:6]; files = sorted(sys.argv[6:])
print(json.dumps({"measured": ok == "true", "video": v, "out": o, "duration_s": round(float(d), 3) if d else None, **({"files": files} if ok == "true" else {"failed": failed})}))' "$@"
}

# the picture track can end before the container: use the shorter of the two
D=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$V" </dev/null)
DV=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$V" </dev/null)
case "$DV" in ''|N/A) ;; *) D=$(python3 -I -c "print(min(float('$D'),float('$DV')))") ;; esac
"$FFPROBE" -v error -show_entries format=duration:stream=codec_type,width,height,r_frame_rate -of json "$V" > "$O/probe.json"
# whole seconds strictly inside the video: a time at or past the last frame fails the whole sheet
T1=$(python3 -I -c "d=float('$D');print('['+','.join(str(float(x)) for x in range(int(d)+1) if x < d-0.25)+']')")
TH=$(python3 -I -c "d=min(5.0,float('$D'));print('['+','.join(str(round(i/6,3)) for i in range(int(d*6)))+']')")

# A long-film PNG can exceed the model transport limit. Keep the original frames,
# then make small chronological pages with native PTS labels (this tool's frame-pages).
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
[ "$FAILED" -eq 0 ] || { said "$V" "$O" "$D" false "hf-media evidence (see sheet.err, scan.err)"; exit 1; }
FILES="probe.json sheet-1fps sheet-hook scan scan.json"
if [ "$SC" -eq 0 ]; then
  "$PAGES_PY" -I "$HERE/keep_a_record_library.py" frame-pages "$O/sheet-1fps/manifest.json" "$O/review-pages" --tile-width 192 --quality 35 > "$O/review-pages.json" 2>>"$O/sheet.err" || { said "$V" "$O" "$D" false "frame-pages (see sheet.err)"; exit 1; }
  FILES="$FILES review-pages review-pages.json"
fi
"$NODE" "$VC/motion-rhythm.mjs" "$V" > "$O/rhythm.json" 2>"$O/rhythm.err" || { said "$V" "$O" "$D" false "motion-rhythm (see rhythm.err)"; exit 1; }
EARSHOT_THREADS="$THREADS" "$EARSHOT_PY" -m earshot timeline "$V" > "$O/earshot-timeline.txt" 2>"$O/earshot.err" || { said "$V" "$O" "$D" false "earshot (see earshot.err)"; exit 1; }
echo "measured $V -> $O (generated evidence only; review still required)" >&2
# shellcheck disable=SC2086
said "$V" "$O" "$D" true "" $FILES rhythm.json earshot-timeline.txt
