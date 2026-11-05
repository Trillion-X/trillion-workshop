"""The `label3` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:959."""


# ---------- nutrition label with a mark on every row ----------
def ev_label3(self, e):
    """r2's label, with a value mark on every row (labels-show-value); marks are data per row."""
    missing = [r['text'] for r in e['rows'] if not r.get('mark')]
    if missing:
        raise SystemExit(f'{self.id}: label rows without a value mark: {missing}')
    x_end, y_end = e['pos']
    W_ = e.get('w', 520)
    h_full = int(e.get('row_px', 34) * 1.55) * len(e['rows']) + 40
    self.safe_box(e.get('id', 'label'), x_end, y_end, x_end + W_, y_end + h_full, self.T(e['at']))
    return self.ev_label(e)
