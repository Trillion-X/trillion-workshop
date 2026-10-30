# Builds a .cube colour lookup table (LUT) that turns a camera's log footage into display colour. The camera, its log curve,
# its gamut matrix and the person's look choices are not in this script: they are one profile the person passes in
# (--profile FILE, a JSON record of kind "log-to-display-profile"; see the README for every field).
# usage: python3 make_lut.py --profile FILE.json --out FILE.cube [--exposure N] [--saturation N] [--size N] [--red-gain N] [--blue-gain N]
# A flag overrides the same setting in the profile's "settings"; a setting in neither is neutral (exposure 1, saturation 1,
# gains 1) and size 65. The last line printed is {"result": {...}} or {"error": "what to change"}.
import argparse
import json
import sys

import numpy as np

NEUTRAL_SETTINGS = {"exposure": 1.0, "saturation": 1.0, "size": 65, "red_gain": 1.0, "blue_gain": 1.0}


class ProfileError(Exception):
    """The profile is missing something or holds something that is not a number; the message says what to change."""


def number(profile, *path):
    value = profile
    for step in path:
        if not isinstance(value, dict) or step not in value:
            raise ProfileError(f"The profile needs {'.'.join(path)}.")
        value = value[step]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProfileError(f"The profile's {'.'.join(path)} must be a number.")
    return float(value)


def numbers(profile, count, *path):
    value = profile
    for step in path:
        if not isinstance(value, dict) or step not in value:
            raise ProfileError(f"The profile needs {'.'.join(path)}.")
        value = value[step]
    if not isinstance(value, list) or len(value) != count or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in value):
        raise ProfileError(f"The profile's {'.'.join(path)} must be a list of {count} numbers.")
    return np.array([float(v) for v in value])


def read_profile(path):
    try:
        with open(path) as handle:
            profile = json.load(handle)
    except OSError:
        raise ProfileError(f"The profile {path} is not there. Pass the path of a log-to-display-profile JSON file.")
    except ValueError:
        raise ProfileError(f"The profile {path} is not JSON. Pass a log-to-display-profile record as JSON.")
    if not isinstance(profile, dict) or profile.get("kind") != "log-to-display-profile":
        raise ProfileError('The profile must be an object with "kind": "log-to-display-profile".')
    if not isinstance(profile.get("title"), str) or not profile["title"]:
        raise ProfileError("The profile needs a title (words for the table's TITLE line).")
    shape = {
        "code_scale": number(profile, "log_curve", "code_scale"),
        "cut_code": number(profile, "log_curve", "cut_code"),
        "base": number(profile, "log_curve", "log", "base"),
        "offset_code": number(profile, "log_curve", "log", "offset_code"),
        "slope_code": number(profile, "log_curve", "log", "slope_code"),
        "mid_grey": number(profile, "log_curve", "log", "mid_grey"),
        "pedestal": number(profile, "log_curve", "log", "pedestal"),
        "toe_origin_code": number(profile, "log_curve", "toe", "origin_code"),
        "toe_linear_at_cut": number(profile, "log_curve", "toe", "linear_at_cut"),
        "gamut_matrix": np.array(gamut_rows(profile)),
        "luma_weights": numbers(profile, 3, "luma_weights"),
        "black_code": number(profile, "video_range", "black_code"),
        "white_code": number(profile, "video_range", "white_code"),
        "shoulder": [number(profile, "shoulder", name) for name in ("a", "b", "c", "d", "e")],
        "display_gamma": number(profile, "display_gamma"),
    }
    if shape["code_scale"] <= 0 or shape["slope_code"] == 0 or shape["cut_code"] == shape["toe_origin_code"] or shape["display_gamma"] <= 0:
        raise ProfileError("The profile's code_scale and display_gamma must be above 0, slope_code not 0, and cut_code not equal to toe.origin_code.")
    settings = profile.get("settings", {})
    if not isinstance(settings, dict) or any(name not in NEUTRAL_SETTINGS for name in settings):
        raise ProfileError("The profile's settings may hold only exposure, saturation, size, red_gain and blue_gain.")
    return profile["title"], shape, settings


def gamut_rows(profile):
    matrix = profile.get("gamut_matrix")
    if not isinstance(matrix, list) or len(matrix) != 3:
        raise ProfileError("The profile's gamut_matrix must be 3 rows of 3 numbers.")
    rows = []
    for index, row in enumerate(matrix):
        if not isinstance(row, list) or len(row) != 3 or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in row):
            raise ProfileError(f"The profile's gamut_matrix row {index} must be 3 numbers.")
        rows.append([float(v) for v in row])
    return rows


def log_to_linear(code_value, curve):
    """Scene-linear light from a log code value written as a share of the code scale: a log segment above the cut code and
    a straight line below it, both read from the profile."""
    x = code_value * curve["code_scale"]
    return np.where(x >= curve["cut_code"],
                    curve["base"] ** ((x - curve["offset_code"]) / curve["slope_code"]) * (curve["mid_grey"] + curve["pedestal"]) - curve["pedestal"],
                    (x - curve["toe_origin_code"]) * curve["toe_linear_at_cut"] / (curve["cut_code"] - curve["toe_origin_code"]))


def shoulder(x, coefficients):
    """The profile's soft shoulder, a rational curve (a x^2 + b x) / (c x^2 + d x + e) that rolls highlights off, kept in 0..1."""
    a, b, c, d, e = coefficients
    return np.clip((x * (a * x + b)) / (x * (c * x + d) + e), 0, 1)


def lut_entries(curve, exposure, saturation, size, red_gain, blue_gain):
    """The table's rows: size**3 display RGB triples, red varying fastest (the .cube order)."""
    white_balance = np.array([red_gain, 1.0, blue_gain])
    axis = np.linspace(0, 1, size)
    blue, green, red = np.meshgrid(axis, axis, axis, indexing="ij")
    rgb = np.stack([red, green, blue], -1).reshape(-1, 3)
    # Undo the expansion a decoder applies when it turns limited-range video into full-range RGB.
    code = (rgb * (curve["white_code"] - curve["black_code"]) + curve["black_code"]) / curve["code_scale"]
    # Some builds of numpy on macOS (Accelerate) raise spurious floating-point flags from matmul on finite numbers; the
    # answer is checked finite in main(), so the flags are silenced here and nowhere else.
    with np.errstate(all="ignore"):
        linear = log_to_linear(code, curve) @ curve["gamut_matrix"].T * exposure * white_balance
        luma = linear @ curve["luma_weights"]
    linear = luma[:, None] + (linear - luma[:, None]) * saturation
    return shoulder(np.maximum(linear, 0), curve["shoulder"]) ** (1 / curve["display_gamma"])


def write_cube(path, entries, title, exposure, saturation, size):
    with open(path, "w") as out:
        out.write(f'TITLE "{title} exp {exposure} sat {saturation}"\nLUT_3D_SIZE {size}\n')
        for p in entries:
            out.write(f"{p[0]:.6f} {p[1]:.6f} {p[2]:.6f}\n")


def main(argv):
    parser = argparse.ArgumentParser(description="Build a .cube LUT from a log-to-display profile.")
    parser.add_argument("--profile", required=True, help="the log-to-display-profile JSON file")
    parser.add_argument("--out", required=True, help="the .cube file to write")
    parser.add_argument("--exposure", type=float, help="linear gain before the shoulder (overrides the profile)")
    parser.add_argument("--saturation", type=float, help="1.0 keeps colour, 0 gives grey (overrides the profile)")
    parser.add_argument("--size", type=int, help="points per side of the 3D table (overrides the profile)")
    parser.add_argument("--red-gain", type=float, help="white balance: multiplies red (overrides the profile)")
    parser.add_argument("--blue-gain", type=float, help="white balance: multiplies blue (overrides the profile)")
    args = parser.parse_args(argv)
    try:
        title, curve, settings = read_profile(args.profile)
    except ProfileError as refusal:
        print(json.dumps({"error": str(refusal)}))
        return 2
    chosen = {**NEUTRAL_SETTINGS, **settings}
    for name, flag in (("exposure", args.exposure), ("saturation", args.saturation), ("size", args.size),
                       ("red_gain", args.red_gain), ("blue_gain", args.blue_gain)):
        if flag is not None:
            chosen[name] = flag
    for name in ("exposure", "saturation", "red_gain", "blue_gain"):
        chosen[name] = float(chosen[name])
    size = int(chosen["size"])
    if size < 2:
        print(json.dumps({"error": "size must be 2 or more; a 3D table needs two points on each side. Try 33 or 65."}))
        return 2
    entries = lut_entries(curve, chosen["exposure"], chosen["saturation"], size, chosen["red_gain"], chosen["blue_gain"])
    if not np.isfinite(entries).all():
        print(json.dumps({"error": "The profile and settings gave a table with values that are not numbers; check the curve numbers, and use an exposure and gains above 0."}))
        return 2
    write_cube(args.out, entries, title, chosen["exposure"], chosen["saturation"], size)
    print(json.dumps({"result": {"lut": args.out, "profile": title, "size": size, "entries": int(entries.shape[0]),
                                 "exposure": chosen["exposure"], "saturation": chosen["saturation"],
                                 "red_gain": chosen["red_gain"], "blue_gain": chosen["blue_gain"]}}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
