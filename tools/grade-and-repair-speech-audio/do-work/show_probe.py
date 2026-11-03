"""Print a probe.json (from probe_speech.py) as one line per span.

  show_probe.py DIR/probe.json
"""
import json
import sys

for sid, d in json.load(open(sys.argv[1])).items():
    print(
        sid.ljust(24),
        "dur%5.1f lufs%6.1f tp%5.1f nf%6.1f snr%5.1f clip%.4f hum%5.1f@%d lf%6.1f/%.2f tail%s %s"
        % (d["duration"], d["lufs"], d["true_peak_db"], d["noise_floor_dbfs"], d["snr_db"], d["clip_fraction"],
           d["hum_prominence_db"], d["hum_hz"], d["lf_rumble_dbfs"], d["lf_noise_share"], d["room_tail_db"],
           d["noise_method"][:4]),
    )
