"""Make a complete browser video from a locally staged namespace file.

The sealed Workshop runner places the original in its temporary container. This
worker verifies input bytes, duration and output codecs before it keeps a preview.
"""

import json
import os
import subprocess
import sys


def probe(path):
    raw = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,pix_fmt", "-of", "json", path],
        text=True,
    )
    return json.loads(raw)


def duration(info):
    return float(info["format"]["duration"])


def main():
    video, max_width, expected, original_bytes, selftest = sys.argv[1:6]
    max_width = int(max_width)
    expected = float(expected)
    original_bytes = int(original_bytes)
    selftest = selftest.lower() == "true"
    if selftest:
        video = "/work/browser-preview-sample-input.mp4"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
             "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1.2", "-vf", "format=yuv422p10le",
             "-c:v", "libx264", "-pix_fmt", "yuv422p10le", "-color_range", "pc", "-c:a", "aac", video],
            check=True,
        )
    if not os.path.isfile(video):
        raise SystemExit("The source video was not placed in the container.")
    source_size = os.path.getsize(video)
    if original_bytes and source_size != original_bytes:
        raise SystemExit(f"The source video has {source_size} bytes, expected {original_bytes}; refusing a short preview.")
    source = probe(video)
    source_duration = duration(source)
    target = expected if expected > 0 else source_duration
    if abs(source_duration - target) > max(0.5, target * 0.002):
        raise SystemExit(f"The source is {source_duration:.3f} seconds, expected {target:.3f}; refusing the wrong file.")
    out = "/work/browser-preview.mp4"
    vf = f"scale=w='min({max_width},iw)':h=-2:flags=lanczos,format=yuv420p"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", video,
         "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-vf", vf,
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out],
        check=True,
    )
    made = probe(out)
    actual = duration(made)
    if abs(actual - target) > max(0.5, target * 0.002):
        os.remove(out)
        raise SystemExit(f"Only {actual:.3f} of {target:.3f} seconds rendered; refusing an incomplete preview.")
    streams = made.get("streams", [])
    picture = next((row for row in streams if row.get("codec_type") == "video"), {})
    sound = next((row for row in streams if row.get("codec_type") == "audio"), {})
    # FFprobe reports full-range 8-bit 4:2:0 as yuvj420p. It is the same browser-ready
    # sample layout as yuv420p; rejecting it discards valid renders of full-range sources.
    if picture.get("codec_name") != "h264" or picture.get("pix_fmt") not in ("yuv420p", "yuvj420p") or (sound and sound.get("codec_name") != "aac"):
        os.remove(out)
        raise SystemExit("The rendered codecs are not browser compatible.")
    print(json.dumps({"status": "complete", "duration_seconds": actual, "source_duration_seconds": source_duration,
                      "source_bytes": source_size, "bytes": os.path.getsize(out), "video_codec": picture.get("codec_name"),
                      "pixel_format": picture.get("pix_fmt"), "audio_codec": sound.get("codec_name")}))


if __name__ == "__main__":
    main()
