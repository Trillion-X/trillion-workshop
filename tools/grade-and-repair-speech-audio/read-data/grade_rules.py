"""Turn one measurement into good|remaster|clone with reasons. The thresholds are the person's settings (settings.py)."""


def faults(m, t):
    """Return (reasons, hard) where hard are faults a remaster cannot be trusted to fix."""
    reasons, hard = [], []
    if m["snr_db"] < t["snr_db_min"]:
        reasons.append(f"noise: snr {m['snr_db']} dB < {t['snr_db_min']} (floor {m['noise_floor_dbfs']} dBFS)")
        if m["snr_db"] < t["snr_db_hard_min"]:
            hard.append("snr")
    if m["hum_prominence_db"] >= t["hum_prominence_db_max"] and m["snr_db"] < t["hum_applies_when_snr_below"]:
        reasons.append(f"hum: {m['hum_hz']} Hz stands {m['hum_prominence_db']} dB above its neighbours")
    if m["tail_samples"] >= t["room_tail_min_samples"] and m["room_tail_db"] > t["room_tail_db_max"]:
        reasons.append(f"room: tail after word ends {m['room_tail_db']} dB under the word (> {t['room_tail_db_max']})")
        hard.append("room")
    if m["lf_noise_share"] >= t["rumble_share_max"] and m["noise_floor_dbfs"] > t["rumble_applies_when_noise_floor_above_dbfs"]:
        reasons.append(f"wind/rumble: {int(m['lf_noise_share'] * 100)}% of the noise below 120 Hz")
    if m["clip_fraction"] > t["clip_fraction_max"] or m["true_peak_db"] > t["true_peak_db_max"]:
        reasons.append(f"clipping: {m['clip_fraction']:.4f} of samples at full scale, true peak {m['true_peak_db']} dB")
        if m["clip_fraction"] > t["clip_fraction_max"]:
            hard.append("clip")
    if not t["lufs_min"] <= m["lufs"] <= t["lufs_max"]:
        reasons.append(f"loudness: {m['lufs']} LUFS outside {t['lufs_min']}..{t['lufs_max']}")
    return reasons, hard


def grade_raw(m, t):
    reasons, _ = faults(m, t)
    return ("remaster" if reasons else "good"), reasons


def grade_after_remaster(m, t):
    """clone only when the remastered cut still fails a line a remaster cannot be trusted to fix."""
    reasons, hard = faults(m, t)
    return ("clone" if hard else "remaster"), reasons
