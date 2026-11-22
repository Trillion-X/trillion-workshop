# read-a-videos-shape

Reads one video's width, height, frame rate and duration with ffprobe, so a check can compare them with a series' declared
aspect and length. It reads the container only; nothing is decoded.

| File | Purpose |
|------|---------|
| `do-work/read_videos_shape.py` | The probe. Prints `{"result": {...}}` or `{"error": ...}`. |
| `test/test_read_videos_shape.py` | Makes a 1080x1920, 30 fps, 2 s clip with ffmpeg and checks the reading and the refusals. |
| `tool-rows.json` | The one Workshop row, `tool:read-a-videos-shape`. |
| `part.json` | Nothing here is imported by other code. |

The file must be on the person's computer: a span read of the Files identity writes it first, so the Files session never
reads a whole video.

Run: `python3 -I tools/read-a-videos-shape/do-work/read_videos_shape.py clip.mp4`
Test: `python3 -I -m unittest discover -s tools/read-a-videos-shape/test -p 'test_*.py'`
