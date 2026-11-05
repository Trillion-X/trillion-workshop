"""Sound classes: play(self, kind, t, max_s=None) registers a class of the settings' `sound_classes` section on the build
(Build.extra_sounds, so the render's mix uses it) and schedules it. Gains come from each class's measured and target levels, so
every class keeps its place against the others (balanced sound classes, no harsh sounds). max_s shortens a sound to follow a
shorter motion.

Settings section `sound_classes`: {kind: {file, max_s, measured_m_lufs, target_m_lufs}}; file relative to the assets folder."""
from overlay import look


def play(self, kind, t, max_s=None):
    c = look.section('sound_classes')[kind]
    length = min(max_s, c['max_s']) if max_s else c['max_s']
    key = kind if not max_s else f'{kind}-{length:.2f}'
    if key not in self.extra_sounds:
        self.extra_sounds[key] = [{'file': look.asset(c['file']), 'gain_db': round(c['target_m_lufs'] - c['measured_m_lufs'], 1), 'max_s': length}]
    self.sound(key, t)
