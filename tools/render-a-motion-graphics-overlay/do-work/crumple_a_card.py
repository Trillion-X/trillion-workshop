#!/usr/bin/env python3
"""Crumple the real card image into a paper ball (Blender cloth simulation).

Usage:
  python3 crumple.py --card card.png --out DIR [--seconds 0.55] [--fps 23.976] [--seed 1]

Technique: a paper crumple (a cloth simulation of the card itself folding into a ball).

One file, two modes. Run with system python it launches Blender headless (this same
file as the Blender script), then measures the rendered frames and writes crumple.json.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

BLENDER = os.environ.get("BLENDER") or shutil.which("blender") or "blender"      # by name on this computer's PATH, or where it reports it

# All tunable numbers live here as data. Lengths are Blender units, 1 unit = 100 card pixels.
PARAMS = {
    "margin_fraction": 0.10,      # canvas margin on each side, as a fraction of the card's longer side
    "grid_long_side": 60,        # cloth vertices along the card's longer side
    "sim_steps_per_frame": 3,     # cloth sim frames per rendered frame (finer motion, stable contact)
    "target_ball_fraction": 0.23, # ball diameter target as a fraction of card width
    "shrink_end": 0.08,           # cloth shrink factor reached at the last frame (0 = none)
    "shrink_noise": 0.85,         # how much the shrink varies across the sheet (breaks symmetry into folds)
    "pin_weight": 0.9,           # 1 = vertices locked to the ball target; low = soft pull, cloth still folds
    "pin_stiffness": 1.0,         # spring strength of that pull
    "ball_noise": 0.7,           # seeded roughness of the target ball (fraction of its radius)
    "facet_sharpness": 200.0,     # higher = narrower creases between facets
    "facets": 24,                 # number of flat facets in the crumpled target
    "wrap_turns": 1.0,            # how far round the ball the card wraps (1 = once round, ends meet behind)
    "radial_weight": 0.6,         # share of the shrink weight that grows with distance from the centre (edges fold in harder)
    "bending_stiffness": 20.0,      # stiff like paper: large flat facets, not cloth wrinkles (round-3 tuning, 2026-10-20)
    "tension_stiffness": 15.0,
    "compression_stiffness": 15.0,
    "shear_stiffness": 5.0,
    "mass": 0.3,
    "quality": 8,
    "self_distance": 0.03,
    "air_damping": 1.0,
    "start_still_fraction": 0.0,  # share of the time the card stays flat before folding starts
    "ease_power": 1.4,            # folding progress = time ** this (1 = linear)
    "ambient": 0.38,              # darkest facet brightness relative to a flat facet
    "light_dir": [-0.45, 0.55, 0.70],  # direction toward the light (x right, y up, z toward camera)
    "smooth_shading": False,      # False = flat facets (paper-like creases); True = soft cloth look
    "pixel_filter": 0.5,          # render pixel filter width in px (default 1.5 would soften frame 0)
    "samples": 16,
}


# --------------------------------------------------------------------------- Blender side
def blender_main(argv):
    import bpy
    import math
    import random
    from mathutils import Vector

    a = json.loads(argv[0])
    P = a["params"]
    rnd = random.Random(a["seed"])
    cw, ch = a["card_size"]
    canvas_w, canvas_h = a["canvas"]
    unit = 100.0
    W, H = cw / unit, ch / unit
    nframes = a["frames"]
    steps = P["sim_steps_per_frame"]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = P["samples"]
    scene.render.resolution_x, scene.render.resolution_y = canvas_w, canvas_h
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.dither_intensity = 0.0
    scene.render.filter_size = P["pixel_filter"]
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.display_settings.display_device = "sRGB"
    scene.frame_start = 1
    scene.frame_end = nframes * steps + 1

    # Camera: orthographic, straight down at the plane, 100 px per unit so frame 0 = the flat card.
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = canvas_w / unit
    cam = bpy.data.objects.new("cam", cam_data)
    cam.location = (0, 0, 20)
    scene.collection.objects.link(cam)
    scene.camera = cam

    # Subdivided plane, UVs span the card exactly.
    if W >= H:
        gx, gy = P["grid_long_side"], max(2, round(P["grid_long_side"] * H / W))
    else:
        gy, gx = P["grid_long_side"], max(2, round(P["grid_long_side"] * W / H))
    verts, faces = [], []
    for j in range(gy + 1):
        for i in range(gx + 1):
            verts.append((-W / 2 + W * i / gx, -H / 2 + H * j / gy, 0.0))
    for j in range(gy):
        for i in range(gx):
            k = j * (gx + 1) + i
            faces.append((k, k + 1, k + gx + 2))  # triangles: each facet is exactly flat, so creases read as paper
            faces.append((k, k + gx + 2, k + gx + 1))
    mesh = bpy.data.meshes.new("card")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="uv")
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            v = mesh.vertices[mesh.loops[li].vertex_index].co
            uv_layer.data[li].uv = ((v.x + W / 2) / W, (v.y + H / 2) / H)
    for poly in mesh.polygons:
        poly.use_smooth = P["smooth_shading"]
    obj = bpy.data.objects.new("card", mesh)
    scene.collection.objects.link(obj)

    # Seeded low-frequency noise: where the sheet shrinks more (becomes the folds).
    waves = [(rnd.uniform(0.4, 2.2), rnd.uniform(0.4, 2.2), rnd.uniform(0, 6.283), rnd.uniform(0, 6.283)) for _ in range(5)]
    vg = obj.vertex_groups.new(name="shrink")
    for idx, v in enumerate(mesh.vertices):
        n = sum(math.sin(v.co.x * fx + px) * math.sin(v.co.y * fy + py) for fx, fy, px, py in waves) / len(waves)
        r = min(1.0, math.hypot(v.co.x / (W / 2), v.co.y / (H / 2)) / math.sqrt(2))
        w = P["radial_weight"] * r + (1 - P["radial_weight"]) * (0.5 + n * 1.4)
        vg.add([idx], max(0.0, min(1.0, w)), "REPLACE")

    # Material: card image as colour and alpha, normal-based shading so folds read, back side = plain paper.
    img = bpy.data.images.load(a["card"])
    img.alpha_mode = "STRAIGHT"
    mat = bpy.data.materials.new("paper")
    mat.use_nodes = True
    mat.surface_render_method = "DITHERED"
    mat.use_backface_culling = False
    nt = mat.node_tree
    nt.nodes.clear()
    N = nt.nodes.new
    tex = N("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest"
    tex.extension = "CLIP"
    geo = N("ShaderNodeNewGeometry")
    L = Vector(P["light_dir"]).normalized()
    lvec = N("ShaderNodeCombineXYZ")
    lvec.inputs[0].default_value, lvec.inputs[1].default_value, lvec.inputs[2].default_value = L.x, L.y, L.z
    dot = N("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    nt.links.new(geo.outputs["Normal"], dot.inputs[0])
    nt.links.new(lvec.outputs[0], dot.inputs[1])
    flat = N("ShaderNodeMath")  # normalise so a facet facing the camera = 1.0 exactly
    flat.operation = "DIVIDE"
    nt.links.new(dot.outputs["Value"], flat.inputs[0])
    flat.inputs[1].default_value = L.z
    clamp = N("ShaderNodeMath")
    clamp.operation = "MINIMUM"
    nt.links.new(flat.outputs[0], clamp.inputs[0])
    clamp.inputs[1].default_value = 1.12
    floor_ = N("ShaderNodeMath")
    floor_.operation = "MAXIMUM"
    nt.links.new(clamp.outputs[0], floor_.inputs[0])
    floor_.inputs[1].default_value = 0.0
    amb = P["ambient"]
    scale = N("ShaderNodeMath")
    scale.operation = "MULTIPLY_ADD"
    nt.links.new(floor_.outputs[0], scale.inputs[0])
    scale.inputs[1].default_value = 1.0 - amb
    scale.inputs[2].default_value = amb
    back = N("ShaderNodeRGB")
    back.outputs[0].default_value = a["paper_rgba"]
    pick = N("ShaderNodeMix")
    pick.data_type = "RGBA"
    nt.links.new(geo.outputs["Backfacing"], pick.inputs[0])
    nt.links.new(tex.outputs["Color"], pick.inputs[6])
    nt.links.new(back.outputs[0], pick.inputs[7])
    shade = N("ShaderNodeMix")
    shade.data_type = "RGBA"
    shade.blend_type = "MULTIPLY"
    shade.inputs[0].default_value = 1.0
    nt.links.new(pick.outputs[2], shade.inputs[6])
    comb = N("ShaderNodeCombineColor")
    nt.links.new(scale.outputs[0], comb.inputs[0])
    nt.links.new(scale.outputs[0], comb.inputs[1])
    nt.links.new(scale.outputs[0], comb.inputs[2])
    nt.links.new(comb.outputs[0], shade.inputs[7])
    emit = N("ShaderNodeEmission")
    nt.links.new(shade.outputs[2], emit.inputs[0])
    clear = N("ShaderNodeBsdfTransparent")
    mix = N("ShaderNodeMixShader")
    nt.links.new(tex.outputs["Alpha"], mix.inputs[0])
    nt.links.new(clear.outputs[0], mix.inputs[1])
    nt.links.new(emit.outputs[0], mix.inputs[2])
    out = N("ShaderNodeOutputMaterial")
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    obj.data.materials.append(mat)

    # Ball target: the sheet laid onto a rough dome the size of the final ball (shape key). The cloth is pinned
    # softly to this animated target, so it is pulled into a ball but folds and collides as cloth.
    R = P["target_ball_fraction"] * W / 2
    # Flat facets with sharp creases between them: random cells on the sheet, each a tilted plane.
    cells = [(rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-2, 2), rnd.uniform(-2, 2)) for _ in range(P["facets"])]

    def facet_height(u, w_):  # soft nearest-cell blend: flat faces, creases a few vertices wide, no stair steps
        tot = acc = 0.0
        for cx, cy, h0, gx, gy in cells:
            wt = math.exp(-P["facet_sharpness"] * ((cx - u) ** 2 + (cy - w_) ** 2))
            tot += wt
            acc += wt * (h0 + gx * (u - cx) + gy * (w_ - cy))
        return acc / tot if tot > 1e-12 else 0.0

    obj.shape_key_add(name="Basis")
    ball_key = obj.shape_key_add(name="ball")
    for idx, v in enumerate(mesh.vertices):
        u, w_ = v.co.x / (W / 2), v.co.y / (H / 2)
        bump = facet_height(u, w_)
        lon, lat = u * math.pi * P["wrap_turns"], w_ * math.pi / 2 * 0.92
        rad = R * (1.0 + P["ball_noise"] * bump)
        ball_key.data[idx].co = Vector((rad * math.cos(lat) * math.sin(lon), rad * math.sin(lat), rad * math.cos(lat) * math.cos(lon)))
    pin = obj.vertex_groups.new(name="pin")
    pin.add(list(range(len(mesh.vertices))), P["pin_weight"], "REPLACE")

    # Cloth: no gravity, self collision, shrink grows over time, soft pin to the ball target.
    scene.use_gravity = False
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    cloth = obj.modifiers.new("Cloth", "CLOTH")
    cs = cloth.settings
    cs.quality = P["quality"]
    cs.mass = P["mass"]
    cs.air_damping = P["air_damping"]
    cs.bending_stiffness = P["bending_stiffness"]
    cs.tension_stiffness = P["tension_stiffness"]
    cs.compression_stiffness = P["compression_stiffness"]
    cs.shear_stiffness = P["shear_stiffness"]
    cs.vertex_group_mass = "pin"
    cs.pin_stiffness = P["pin_stiffness"]
    cs.shrink_min = 0.0
    cs.vertex_group_shrink = "shrink"
    cloth.collision_settings.use_self_collision = True
    cloth.collision_settings.self_distance_min = P["self_distance"]
    cloth.collision_settings.self_friction = 5.0
    cloth.collision_settings.collision_quality = 4
    cloth.point_cache.frame_start = 1
    cloth.point_cache.frame_end = scene.frame_end

    start_still = max(1, round(scene.frame_end * P["start_still_fraction"]))

    def ease(t):
        return t ** P["ease_power"]

    for f in range(1, scene.frame_end + 1):
        t = 0.0 if f <= start_still else (f - start_still) / (scene.frame_end - start_still)
        e = ease(t)
        cs.shrink_min = P["shrink_end"] * (1 - P["shrink_noise"]) * e
        cs.keyframe_insert("shrink_min", frame=f)
        cs.shrink_max = P["shrink_end"] * e
        cs.keyframe_insert("shrink_max", frame=f)
        ball_key.value = e
        ball_key.keyframe_insert("value", frame=f)
    cs.shrink_max = 0.0
    cs.shrink_min = 0.0  # resting value must be the frame-1 value; the cloth is initialised from it
    ball_key.value = 0.0

    # Step the simulation frame by frame, render every `steps`-th frame.
    out_dir = a["out"]
    for f in range(1, nframes * steps + 1 + 0):
        scene.frame_set(f)
        if (f - 1) % steps == 0:
            scene.render.filepath = os.path.join(out_dir, "%04d.png" % ((f - 1) // steps))
            bpy.ops.render.render(write_still=True)


# --------------------------------------------------------------------------- driver side
def driver_main():
    from PIL import Image

    ap = argparse.ArgumentParser(description="Crumple a card image into a paper ball with a Blender cloth simulation.")
    ap.add_argument("--card", required=True, help="RGBA PNG of the flat card")
    ap.add_argument("--out", required=True, help="output directory for 0000.png ... and crumple.json")
    ap.add_argument("--seconds", type=float, default=0.55)
    ap.add_argument("--fps", type=float, default=23.976)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--params", default="{}", help="JSON overriding keys of PARAMS (for tuning)")
    args = ap.parse_args()

    params = dict(PARAMS, **json.loads(args.params))
    card = Image.open(args.card).convert("RGBA")
    cw, ch = card.size
    margin = round(max(cw, ch) * params["margin_fraction"])
    canvas = [cw + 2 * margin, ch + 2 * margin]
    frames = max(2, round(args.seconds * args.fps))
    os.makedirs(args.out, exist_ok=True)

    # Paper colour for the back side: mean of the mostly opaque pixels.
    px = [p for p in card.resize((64, 64)).getdata() if p[3] > 200]
    paper = [sum(p[i] for p in px) / len(px) / 255.0 for i in range(3)] + [1.0] if px else [0.95, 0.93, 0.88, 1.0]

    payload = {
        "card": os.path.abspath(args.card), "out": os.path.abspath(args.out), "seed": args.seed,
        "card_size": [cw, ch], "canvas": canvas, "frames": frames, "paper_rgba": paper, "params": params,
    }
    cmd = ["nice", "-n", "10", BLENDER, "-b", "--factory-startup", "--python", os.path.abspath(__file__), "--", json.dumps(payload)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stdout[-3000:] + r.stderr[-3000:])
        sys.exit("Blender failed")

    centres, diameter = [], 0
    for i in range(frames):
        im = Image.open(os.path.join(args.out, "%04d.png" % i)).convert("RGBA")
        if im.size != tuple(canvas):
            sys.exit("frame %d is %s, expected %s" % (i, im.size, canvas))
        bb = im.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
        centres.append([(bb[0] + bb[2]) / 2.0, (bb[1] + bb[3]) / 2.0] if bb else [canvas[0] / 2.0, canvas[1] / 2.0])
        diameter = max(bb[2] - bb[0], bb[3] - bb[1]) if bb else 0
    meta = {
        "frames": frames, "canvas": canvas, "card_origin": [margin, margin], "card_size": [cw, ch],
        "ball_centre": centres, "ball_diameter_px": diameter, "fps": args.fps, "seed": args.seed,
        "params": params,
    }
    with open(os.path.join(args.out, "crumple.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    print(json.dumps({k: meta[k] for k in ("frames", "canvas", "card_origin", "ball_diameter_px")}))


if __name__ == "__main__":
    import importlib.util
    if importlib.util.find_spec("bpy") is None:  # bpy is only importable when Blender runs this file
        driver_main()
    else:
        blender_main(sys.argv[sys.argv.index("--") + 1:])
