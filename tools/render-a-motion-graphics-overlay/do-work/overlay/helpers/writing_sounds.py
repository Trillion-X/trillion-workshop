"""Writing sounds: marker drawing and rows being written are soft swipes, the settings' recordings in turn so no recording is
laid down twice in a row (no looping sounds).

Settings section `writing_sounds`: {files: [recording, ...], gain_db}; files relative to the assets folder."""
from overlay import look


def write_sound(self, i, t, max_s=0.5):
    w = look.section('writing_sounds')
    files = w['files']
    kind = f'write{i % len(files)}'
    if kind not in self.extra_sounds:
        self.extra_sounds[kind] = [{'file': look.asset(files[i % len(files)]), 'gain_db': w['gain_db'], 'max_s': max_s}]
    self.sound(kind, t)
