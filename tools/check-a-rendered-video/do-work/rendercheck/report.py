"""Findings and the PASS/FAIL printout."""
from dataclasses import dataclass, field

from .pins import CHECK_SECTIONS

CHECK_ORDER = list(CHECK_SECTIONS)      # one owner of the check list: pins.CHECK_SECTIONS, so adding a check never changes the shared code every pin covers


@dataclass
class Finding:
    check: str
    status: str  # FAIL | WARN | INFO
    message: str
    t: float | None = None
    t_end: float | None = None
    data: dict = field(default_factory=dict)

    def when(self):
        if self.t is None:
            return ''
        return f'{self.t:.2f}s' if self.t_end is None else f'{self.t:.2f}-{self.t_end:.2f}s'


def verdict(findings):
    if any(f.status == 'FAIL' for f in findings):
        return 'FAIL'
    if any(f.status == 'WARN' for f in findings):
        return 'WARN'
    return 'PASS'


def render(preview, results, skipped):
    """results: {check: [Finding]}; skipped: {check: reason}. Returns (text, any_fail)."""
    lines = [f'check-a-rendered-video  {preview}']
    any_fail = False
    for name in CHECK_ORDER:
        if name in skipped:
            lines.append(f'  SKIP  {name:10s} {skipped[name]}')
            continue
        if name not in results:
            continue
        fs = results[name]
        v = verdict(fs)
        any_fail |= v == 'FAIL'
        lines.append(f'  {v:5s} {name}')
        for f in fs:
            lines.append(f'        {f.status:4s} {f.when():>14s}  {f.message}')
    return '\n'.join(lines), any_fail
