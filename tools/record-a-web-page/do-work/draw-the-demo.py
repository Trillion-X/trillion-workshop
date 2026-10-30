#!/usr/bin/env python3
"""tools/record-a-web-page/do-work/draw-the-demo.py

Draws a recorded web page session as a finished demo. Reads the one timed list record-a-web-demo.mjs wrote
(events.json: the frames the browser painted with their times, the pointer's path, the clicks, and each step with
its target box and picture) and leaves in the output folder:

  demo.mp4                  the video: real frames, a large drawn pointer, a ripple at every click, and a camera
                            that eases in toward each step's target and back out for scrolls and page changes
  demo.gif                  the same video, smaller and slower, for places that do not play video
  step-pictures/cover.png   the video's frame at the first click, pointer and ripple included, for a thumbnail
  step-pictures/step-NN.png each step's settled picture with its target ringed and an arrow pointing at it,
                            and the step's caption beside the arrow when it has one

Invariants:
  - Nothing here names a site or brand: colours and the caption font come from events.json render.look.
  - Every frame goes through one function (draw_frame); the pointer, ripple and camera are functions of time read
    from the timed list, never typed by hand.
  - The pointer is drawn as a shape, so it is sharp at any size.

Carried from the browser-video-recording skill's renderer (render_browser_demo.py): the eased keyframe
interpolation, the click dip and overshoot, the tilt from sideways speed, and the camera crop and resize.

Prints one JSON line: { seconds, frames, width, height, fps, steps[] }.
"""

from __future__ import annotations

import bisect
import json
import math
import os
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

DEFAULT_LOOK = {"accent": "#ff1d1d", "ink": "#191919", "paper": "#ffffff", "pointer_edge": "#ffffff", "font_file": None}


def colour(text: str, alpha: int = 255) -> tuple[int, int, int, int]:
    value = text.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha)


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def ease_out(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return 1.0 - (1.0 - value) ** 3


def ease_out_back(value: float) -> float:
    value = max(0.0, min(1.0, value))
    c1 = 1.28
    return 1.0 + (c1 + 1.0) * (value - 1.0) ** 3 + c1 * (value - 1.0) ** 2


def eased_keys(keys: list[tuple[float, ...]], time_s: float) -> tuple[float, ...]:
    """Value at time_s between keyframes (t, *values), eased with smoothstep; holds the ends."""
    if time_s <= keys[0][0]:
        return keys[0][1:]
    for start, end in zip(keys, keys[1:]):
        if time_s <= end[0]:
            amount = smoothstep((time_s - start[0]) / max(1e-6, end[0] - start[0]))
            return tuple(a + (b - a) * amount for a, b in zip(start[1:], end[1:]))
    return keys[-1][1:]


def linear_path(samples: list[tuple[float, float, float]], time_s: float) -> tuple[float, float]:
    times = [sample[0] for sample in samples]
    index = bisect.bisect_right(times, time_s)
    if index == 0:
        return samples[0][1], samples[0][2]
    if index >= len(samples):
        return samples[-1][1], samples[-1][2]
    a, b = samples[index - 1], samples[index]
    amount = (time_s - a[0]) / max(1e-6, b[0] - a[0])
    return a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount


def click_scale(time_s: float, clicks: list[float], strength: float = 0.16) -> float:
    for click in clicks:
        elapsed = time_s - click
        if 0 <= elapsed <= 0.28:
            overshoot = strength * 0.22
            if elapsed <= 0.08:
                return 1.0 - strength * ease_out(elapsed / 0.08)
            if elapsed <= 0.19:
                return (1.0 - strength) + (strength + overshoot) * ease_out_back((elapsed - 0.08) / 0.11)
            return 1.0 + overshoot * (1.0 - smoothstep((elapsed - 0.19) / 0.09))
    return 1.0


# ---------------------------------------------------------------------------------------------------------------
# The pointer: a classic arrow drawn at four times its size and reduced, with a white edge and a soft shadow.

ARROW = [(0, 0), (0, 16.2), (3.9, 12.6), (6.6, 18.6), (9.2, 17.5), (6.6, 11.6), (11.8, 11.6)]


def make_pointer(height_px: int, ink, paper) -> tuple[Image.Image, tuple[float, float]]:
    grow = 4
    unit = height_px * grow / 18.6
    pad = int(height_px * grow * 0.35)
    size = (int(12.5 * unit) + pad * 2, int(19.5 * unit) + pad * 2)
    points = [(pad + x * unit, pad + y * unit) for x, y in ARROW]
    edge = max(2, int(unit * 1.5))
    shadow = Image.new("RGBA", size, (0, 0, 0, 0))
    shade = ImageDraw.Draw(shadow)
    offset = [(x + unit * 0.4, y + unit * 0.8) for x, y in points]
    shade.polygon(offset, fill=(0, 0, 0, 110))
    shade.line(offset + [offset[0]], fill=(0, 0, 0, 110), width=edge, joint="curve")
    shadow = shadow.filter(ImageFilter.GaussianBlur(unit * 0.8))
    shape = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(shape)
    # The ink body, then the paper edge drawn over its outline: half the edge lies outside, half inside.
    draw.polygon(points, fill=ink)
    draw.line(points + [points[0], points[1]], fill=paper, width=edge, joint="curve")
    shadow.alpha_composite(shape)
    small = shadow.resize((size[0] // grow, size[1] // grow), Image.Resampling.LANCZOS)
    return small, (pad / grow, pad / grow)


# ---------------------------------------------------------------------------------------------------------------


class Demo:
    def __init__(self, recording: dict, out: Path):
        self.out = out
        view = recording["view"]
        render = recording["render"]
        self.look = {**DEFAULT_LOOK, **{k: v for k, v in (render.get("look") or {}).items() if v}}
        self.scale = float(view["scale"])
        self.source_size = (int(view["width"] * self.scale), int(view["height"] * self.scale))
        self.fps = int(render["fps"])
        out_w = int(render["output_width"])
        out_w -= out_w % 2
        out_h = int(round(out_w * view["height"] / view["width"]))
        out_h -= out_h % 2
        self.output_size = (out_w, out_h)
        self.gif_width = int(render["gif_width"])
        self.gif_fps = int(render.get("gif_fps", 12))
        self.zoom = max(1.0, float(render["zoom"]))
        self.max_idle = float(render.get("max_idle", 0.9))
        self.t0 = float(recording["started_at"])
        self.duration = float(recording["ended_at"]) - self.t0
        frames = sorted(recording["frames"], key=lambda f: f["t"])
        self.frame_times = [f["t"] - self.t0 for f in frames]
        self.frame_files = [f["file"] for f in frames]
        self.loaded: tuple[int, Image.Image] | None = None
        self.pointer_path = [(p["t"] - self.t0, p["x"] * self.scale, p["y"] * self.scale) for p in recording["pointer"]]
        self.clicks = [c["t"] - self.t0 for c in recording["clicks"]]
        self.click_points = [(c["t"] - self.t0, c["x"] * self.scale, c["y"] * self.scale) for c in recording["clicks"]]
        self.steps = recording["steps"]
        pointer_px = int(render["cursor_size"])
        self.pointer, self.hotspot = make_pointer(pointer_px, colour(self.look["ink"]), colour(self.look["pointer_edge"]))
        self.pointer_px = pointer_px
        self.camera_keys = self.plan_camera()
        self.background_key = None
        self.background_image: Image.Image | None = None
        self.pointer_sizes: dict[float, Image.Image] = {}

    # The camera eases toward each step's target and holds there; scrolls, page changes and the end pull back out.
    def plan_camera(self) -> list[tuple[float, float, float, float]]:
        cx, cy = self.source_size[0] / 2, self.source_size[1] / 2
        keys = [(0.0, cx, cy, 1.0)]
        for step in self.steps:
            began, acted = step["began"] - self.t0, step["acted"] - self.t0
            box = step.get("target")
            if box and self.zoom > 1.0:
                tx = (box["x"] + box["width"] / 2) * self.scale
                ty = (box["y"] + box["height"] / 2) * self.scale
                keys.append((max(keys[-1][0] + 0.05, began), *keys[-1][1:]))
                keys.append((max(keys[-1][0] + 0.3, acted - 0.05), tx, ty, self.zoom))
            else:
                keys.append((max(keys[-1][0] + 0.05, began), *keys[-1][1:]))
                keys.append((max(keys[-1][0] + 0.4, began + 0.6), cx, cy, 1.0))
        end = self.duration
        keys.append((max(keys[-1][0] + 0.05, end - 1.0), *keys[-1][1:]))
        keys.append((max(keys[-1][0] + 0.3, end - 0.1), cx, cy, 1.0))
        return keys

    def source_at(self, time_s: float) -> Image.Image:
        index = max(0, bisect.bisect_right(self.frame_times, time_s) - 1)
        if self.loaded is None or self.loaded[0] != index:
            image = Image.open(self.frame_files[index]).convert("RGB")
            if image.size != self.source_size:
                image = image.resize(self.source_size, Image.Resampling.BICUBIC)
            self.loaded = (index, image)
        return self.loaded[1]

    def camera_box(self, time_s: float) -> tuple[float, float, float, float]:
        cx, cy, zoom = eased_keys(self.camera_keys, time_s)
        sw, sh = self.source_size
        w, h = sw / zoom, sh / zoom
        left = max(0.0, min(sw - w, cx - w / 2))
        top = max(0.0, min(sh - h, cy - h / 2))
        return left, top, w, h

    # The page under the camera, resized once per (source frame, camera box): holds and pauses reuse it.
    def background(self, time_s: float) -> tuple[Image.Image, tuple[float, float, float, float]]:
        box = tuple(round(v, 1) for v in self.camera_box(time_s))
        source = self.source_at(time_s)
        key = (self.loaded[0], box)
        if self.background_key != key:
            left, top, w, h = box
            self.background_image = source.resize(self.output_size, Image.Resampling.BICUBIC, box=(left, top, left + w, top + h))
            self.background_key = key
        return self.background_image, box

    def sized_pointer(self, size: float) -> Image.Image:
        size = round(size, 3)
        if size not in self.pointer_sizes:
            self.pointer_sizes[size] = self.pointer.resize((max(1, int(self.pointer.width * size)), max(1, int(self.pointer.height * size))), Image.Resampling.LANCZOS)
        return self.pointer_sizes[size]

    def draw_frame(self, time_s: float, previous_x: float) -> tuple[Image.Image, float]:
        base, (left, top, w, h) = self.background(time_s)
        frame = base.copy()
        ow, oh = self.output_size
        to_screen = lambda x, y: ((x - left) / w * ow, (y - top) / h * oh)
        zoom_now = self.source_size[0] / w

        accent = colour(self.look["accent"])
        for click_t, x, y in self.click_points:
            elapsed = time_s - click_t
            if 0 <= elapsed <= 0.55:
                sx, sy = to_screen(x, y)
                grow = ease_out(elapsed / 0.55)
                radius = self.pointer_px * (0.25 + 0.95 * grow) * (0.85 + 0.15 * zoom_now)
                fade = 1.0 - smoothstep(elapsed / 0.55)
                side = int(radius * 2 + 8)
                ring = Image.new("RGBA", (side, side), (0, 0, 0, 0))
                ImageDraw.Draw(ring).ellipse((4, 4, side - 4, side - 4), fill=accent[:3] + (int(60 * fade),),
                                             outline=accent[:3] + (int(235 * fade),), width=max(2, int(self.pointer_px * 0.09 * (1 - grow * 0.5))))
                frame.paste(ring, (int(sx - side / 2), int(sy - side / 2)), ring)

        x, y = linear_path(self.pointer_path, time_s)
        sx, sy = to_screen(x, y)
        size = click_scale(time_s, self.clicks) * (0.9 + 0.1 * zoom_now)
        pointer = self.sized_pointer(size)
        hx, hy = self.hotspot[0] * size, self.hotspot[1] * size
        speed = (x - previous_x) * self.fps
        angle = math.copysign(math.radians(8) * min(1.0, abs(speed) / (1400 * self.scale)) ** 0.72, speed)
        if abs(angle) > 0.002:
            pad = int(max(pointer.size) * 0.45)
            padded = Image.new("RGBA", (pointer.width + pad * 2, pointer.height + pad * 2), (0, 0, 0, 0))
            padded.alpha_composite(pointer, (pad, pad))
            pointer = padded.rotate(math.degrees(angle), resample=Image.Resampling.BICUBIC, expand=True)
            dx, dy = hx + pad - padded.width / 2, hy + pad - padded.height / 2
            hx = pointer.width / 2 + dx * math.cos(-angle) - dy * math.sin(-angle)
            hy = pointer.height / 2 + dx * math.sin(-angle) + dy * math.cos(-angle)
        frame.paste(pointer, (int(round(sx - hx)), int(round(sy - hy))), pointer)
        return frame, x

    # Time where nothing moves and nothing paints (the browser taking a step's picture, a page thinking) is
    # shortened to max_idle, so the video never sits still longer than that. Returns the kept gaps as
    # (real start, seconds removed) and the video's length.
    def plan_idle_cuts(self) -> tuple[list[tuple[float, float]], float]:
        busy = sorted({0.0, self.duration, *self.frame_times, *(p[0] for p in self.pointer_path), *self.clicks})
        busy = [t for t in busy if 0.0 <= t <= self.duration]
        cuts = [(a + self.max_idle, (b - a) - self.max_idle) for a, b in zip(busy, busy[1:]) if b - a > self.max_idle]
        return cuts, self.duration - sum(removed for _, removed in cuts)

    def real_time(self, video_s: float) -> float:
        real = video_s
        for start, removed in self.idle_cuts:
            if real >= start:
                real += removed
        return real

    def video_time(self, real_s: float) -> float:
        return real_s - sum(min(removed, max(0.0, real_s - start)) for start, removed in self.idle_cuts)

    def encode(self) -> int:
        ow, oh = self.output_size
        self.idle_cuts, length = self.plan_idle_cuts()
        total = int(round(length * self.fps))
        video = self.out / "demo.mp4"
        ffmpeg = subprocess.Popen([
            "ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s:v", f"{ow}x{oh}",
            "-r", str(self.fps), "-i", "-", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video),
        ], stdin=subprocess.PIPE)
        first_click = self.clicks[0] if self.clicks else None
        cover_at = int(round(self.video_time(first_click + 0.12) * self.fps)) if first_click is not None else total // 2
        previous_x = self.pointer_path[0][1]
        for index in range(total):
            time_s = self.real_time(index / self.fps)
            frame, previous_x = self.draw_frame(time_s, previous_x)
            if index == cover_at:
                frame.save(self.out / "step-pictures" / "cover.png", optimize=True)
            ffmpeg.stdin.write(frame.tobytes())
        ffmpeg.stdin.close()
        if ffmpeg.wait() != 0:
            raise SystemExit("ffmpeg could not encode the video")
        palette = f"fps={self.gif_fps},scale={self.gif_width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-filter_complex", palette, str(self.out / "demo.gif")], check=True)
        return total

    # Each step's settled picture, marked: the page outside the target dimmed a little, a ring around the target,
    # an arrow from the open side of the picture to the ring, and the caption at the arrow's tail.
    def mark_steps(self) -> list[dict]:
        accent = colour(self.look["accent"])
        ink = colour(self.look["ink"])
        paper = colour(self.look["paper"])
        font_size = max(18, int(self.output_size[1] * 0.034))
        font = ImageFont.truetype(self.look["font_file"], font_size) if self.look.get("font_file") else ImageFont.load_default(font_size)
        made = []
        for step in self.steps:
            if not step.get("still"):
                made.append({"index": step["index"], "do": step["do"], "caption": None, "found": False,
                             "at_seconds": round(self.video_time(step["acted"] - self.t0), 2), "picture": None})
                continue
            source = Path(step["still"])
            picture = Image.open(source).convert("RGBA").resize(self.output_size, Image.Resampling.LANCZOS)
            box = step.get("target")
            name = f"step-{step['index']:02d}.png"
            if box:
                k = self.output_size[0] / (self.source_size[0] / self.scale)
                pad = 10 * k / 1.5
                x0, y0 = box["x"] * k - pad, box["y"] * k - pad
                x1, y1 = (box["x"] + box["width"]) * k + pad, (box["y"] + box["height"]) * k + pad
                shade = Image.new("RGBA", picture.size, (0, 0, 0, 46))
                ImageDraw.Draw(shade).rounded_rectangle((x0, y0, x1, y1), radius=int(12 * k / 1.5), fill=(0, 0, 0, 0))
                picture.alpha_composite(shade)
                marks = Image.new("RGBA", picture.size, (0, 0, 0, 0))
                draw = ImageDraw.Draw(marks)
                stroke = max(3, int(self.output_size[1] * 0.006))
                draw.rounded_rectangle((x0, y0, x1, y1), radius=int(12 * k / 1.5), outline=accent, width=stroke)
                self.arrow(draw, picture.size, (x0, y0, x1, y1), accent, stroke, step.get("caption"), font, ink, paper)
                picture.alpha_composite(marks)
            picture.convert("RGB").save(self.out / "step-pictures" / name, optimize=True)
            source.unlink()
            made.append({"index": step["index"], "do": step["do"], "caption": step.get("caption"), "found": bool(box),
                         "at_seconds": round(self.video_time(step["acted"] - self.t0), 2), "picture": name})
        return made

    def arrow(self, draw, size, ring, accent, stroke, caption, font, ink, paper):
        w, h = size
        x0, y0, x1, y1 = ring
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        # The tail goes toward whichever side of the picture has the most room.
        room = {"below": h - y1, "above": y0, "right": w - x1, "left": x0}
        side = max(room, key=room.get)
        reach = min(max(90.0, room[side] * 0.45), h * 0.22)
        if side == "below":
            tail, head = (cx + reach * 0.55, y1 + reach), (cx + 6, y1 + stroke * 2)
        elif side == "above":
            tail, head = (cx + reach * 0.55, y0 - reach), (cx + 6, y0 - stroke * 2)
        elif side == "right":
            tail, head = (x1 + reach, cy + reach * 0.45), (x1 + stroke * 2, cy)
        else:
            tail, head = (x0 - reach, cy + reach * 0.45), (x0 - stroke * 2, cy)
        # A gentle curve: a quadratic path through a control point off the straight line.
        mx, my = (tail[0] + head[0]) / 2, (tail[1] + head[1]) / 2
        nx, ny = -(head[1] - tail[1]), head[0] - tail[0]
        length = math.hypot(nx, ny) or 1.0
        control = (mx + nx / length * reach * 0.25, my + ny / length * reach * 0.25)
        points = []
        for i in range(33):
            t = i / 32
            points.append(((1 - t) ** 2 * tail[0] + 2 * (1 - t) * t * control[0] + t * t * head[0],
                           (1 - t) ** 2 * tail[1] + 2 * (1 - t) * t * control[1] + t * t * head[1]))
        draw.line(points, fill=accent, width=stroke + 1, joint="curve")
        end_dx, end_dy = head[0] - points[-3][0], head[1] - points[-3][1]
        angle = math.atan2(end_dy, end_dx)
        spread, head_len = math.radians(28), stroke * 5.5
        draw.polygon([head,
                      (head[0] - head_len * math.cos(angle - spread), head[1] - head_len * math.sin(angle - spread)),
                      (head[0] - head_len * math.cos(angle + spread), head[1] - head_len * math.sin(angle + spread))], fill=accent)
        if caption:
            left, top, right, bottom = draw.textbbox((0, 0), caption, font=font)
            tw, th = right - left, bottom - top
            margin = th * 0.7
            bx = min(max(8, tail[0] - tw / 2 - margin), w - tw - margin * 2 - 8)
            by = tail[1] + margin * 0.4 if side != "above" else tail[1] - th - margin * 2.4
            by = min(max(8, by), h - th - margin * 2 - 8)
            draw.rounded_rectangle((bx, by, bx + tw + margin * 2, by + th + margin * 2), radius=int(th * 0.6), fill=paper, outline=accent, width=max(2, stroke // 2))
            draw.text((bx + margin - left, by + margin - top), caption, font=font, fill=ink)


def main() -> int:
    events_file, out = Path(sys.argv[1]), Path(sys.argv[2])
    recording = json.loads(events_file.read_text())
    demo = Demo(recording, out)
    (out / "step-pictures").mkdir(parents=True, exist_ok=True)
    frames = demo.encode()
    steps = demo.mark_steps()
    events_file.unlink()
    print(json.dumps({
        "seconds": round(frames / demo.fps, 2), "frames": frames, "width": demo.output_size[0], "height": demo.output_size[1],
        "fps": demo.fps, "video_bytes": os.path.getsize(out / "demo.mp4"), "gif_bytes": os.path.getsize(out / "demo.gif"),
        "steps": steps,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
