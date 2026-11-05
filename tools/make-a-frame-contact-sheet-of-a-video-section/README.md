# tools/make-a-frame-contact-sheet-of-a-video-section/

Cuts a short section (at most 300 seconds) of a video and lays one frame every few seconds out on a single picture, so a person or their AI can see what happens in it. Runs on the person's own computer.

## Running it

```
python3 -I do-work/make_contact_sheet.py --source URL_OR_FILE --name NAME --start S --end E --folder FOLDER [--step 4] [--cols 4]
```

- A link is fetched with yt-dlp, only the section, at 360p or less (`bv*[height<=360]+ba/b[height<=360]/best`, `--download-sections *S-E`), into `FOLDER/clips/NAME-S-E.<ext>`. A clip already there is used again, so a second run fetches nothing.
- A video file on the computer is read directly from S to E (`ffmpeg -ss S -to E -i FILE`).
- ffmpeg makes `FOLDER/frames/NAME-S-E-sheet.jpg`: `fps=1/STEP,scale=320:-1,tile=COLSxROWS`, where ROWS is enough rows for every frame.
- Every command and its output go to `FOLDER/frames/NAME-S-E.log`. Arguments are separate argv items; nothing is hidden. Each program runs under `nice -n 20`.

The last line printed is `{"result": {"sheet", "clip", "log", "columns", "rows"}}`. On failure it is `{"result": {"error", "log", "log_tail"}}` with exit 1, and the log's last lines are also printed to standard error; a request it cannot use exits 2 with what to fix.

## Files

| File | Purpose |
|---|---|
| `do-work/make_contact_sheet.py` | The command. |
| `test/make-contact-sheet.test.mjs` | The command with stand-in yt-dlp and ffmpeg programs first on PATH, and once with real ffmpeg on a made-up test video when ffmpeg is installed. |
| `tool-rows.json` | The Workshop row. |

## Moved from

`source-repo-a/tools/analysis-devices/grab_frames.py`, which took only a YouTube id and wrote into one library folder of that repository. Here it takes any link or a video file, a name and a folder, and answers one JSON line; the yt-dlp format, the section, the frame step, the scale and the tile are the same, so the same clip gives a byte-identical sheet. Old Trillion (Trillion-X/trillion, `parts/` and `src/`) has no counterpart: no frame grid or section fetch there.

## Dependencies

**Depends on:** Python 3's standard library, `nice`, ffmpeg, and yt-dlp for links.

**Depended on by:** the person's AI, through `tool:make-a-frame-contact-sheet-of-a-video-section`.
