# check-text-in-every-frame

Checks that every sampled frame of a clip shows every required phrase (names, credit text with its year). ffmpeg takes one frame every 2 s; tesseract reads each frame. A phrase counts when it appears after case and whitespace are folded. Pass only when every frame has every phrase; the result lists the frames that miss one. No model judges the picture.

| File | Purpose |
|------|---------|
| `do-work/check_text_in_every_frame.py` | The check. Prints `{"result": {...}}` or `{"error": ...}`. |
| `test/test_check_text_in_every_frame.py` | A made-up card with two names on every frame, and the pass, miss, refusal and missing-clip cases. |
| `what-this-tool-does-and-how-to-run-it.json` | The one Workshop row, `tool:check-text-in-every-frame`. |
| `kits/check-text-in-every-frame.json` | The kit (L082). |
| `part.json` | Nothing here is imported by other code. |

Run: `python3 -I tools/check-text-in-every-frame/do-work/check_text_in_every_frame.py clip.mp4 --phrases '["Name One", "Name Two 2019"]'`
Test: `python3 -I -m unittest discover -s tools/check-text-in-every-frame/test -p 'test_*.py'`
