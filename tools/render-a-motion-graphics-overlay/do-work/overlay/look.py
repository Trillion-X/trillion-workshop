"""The settings of one render: the look (recipe, look, look3), the sound table, named sections the helpers read, and the folders
relative names are read from and written to.

install() runs once per process, before stage, kit, build and the event modules are imported: those modules read these
settings when they load, the way one render reads one look. Every value comes from the request; nothing here has a default.

A settings document is a JSON object. Its keys:
  recipe        the base look: palette, faces, textures, motion, sound table (`sound.events`), card, scrap, cut-out and type rules
  look          the type-on-footage look: faces by role, colours, text shadow, slide and print rules, its own sounds
  look3         the paper look: title-safe margin, compass, fall, sound overlap, edges, type rhythm, count roll, letter faces
  frame         [width, height] of an overlay frame (a spec's own `canvas` replaces it for that spec)
  faces         the folder of font files a face name is read from, relative to `assets` or absolute; "builtin" draws every
                face in Pillow's own font (an example look, or a computer that lacks the faces)
  sound_layers  a list of {kind: [recordings]} tables laid over recipe.sound.events in order (a kind starting _ is a note)
  any other key a named section a helper reads with section(name): a chapter's sound classes, a writing-sound bank, ...
Several documents are merged in order: sound_layers are joined; any other key may come from one document only."""
import os

R, LOOK, LOOK3 = {}, {}, {}
SECTIONS = {}
FOLDERS = {}


class SettingsRefused(Exception):
    """The settings cannot drive a render; the words say what to add or change."""


def install(documents, assets, root, out):
    """documents: settings objects in order; assets: the folder the settings' relative file names are read from; root: the
    folder a spec's relative file names are read from; out: the folder this render writes into."""
    merged, layers, came_from = {}, [], {}
    for i, doc in enumerate(documents):
        for key, value in doc.items():
            if key == 'sound_layers':
                layers += value
                continue
            if key in merged:
                raise SettingsRefused(f'settings: `{key}` is in settings document {came_from[key]} and in document {i}; give it once')
            merged[key], came_from[key] = value, i
    missing = [k for k in ('recipe', 'look', 'look3', 'frame', 'faces') if k not in merged]
    if missing:
        raise SettingsRefused(f'settings: {missing} missing; the settings must give recipe, look, look3, frame and faces')
    for target, key in ((R, 'recipe'), (LOOK, 'look'), (LOOK3, 'look3')):
        target.clear()
        target.update(merged.pop(key))
    for layer in layers:
        for kind, recordings in layer.items():
            if not kind.startswith('_'):
                R['sound']['events'][kind] = recordings
    SECTIONS.clear()
    SECTIONS.update(merged)
    FOLDERS.clear()
    FOLDERS.update({'assets': assets, 'root': root, 'out': out})
    FOLDERS['faces'] = SECTIONS['faces'] if SECTIONS['faces'] == 'builtin' else asset(SECTIONS['faces'])


def section(name):
    """A named settings section a helper needs; refuses by name when the settings do not give it."""
    if name not in SECTIONS:
        raise SystemExit(f'settings: this spec needs the `{name}` section; add it to a settings document')
    return SECTIONS[name]


def asset(path):
    """A settings file name: absolute as given, or relative to the assets folder."""
    return path if os.path.isabs(path) else os.path.join(FOLDERS['assets'], path)


def at_root(path):
    """A spec's file name: absolute as given, or relative to the root folder."""
    return path if os.path.isabs(path) else os.path.join(FOLDERS['root'], path)


def out_path(*parts):
    """A path inside this render's output folder."""
    return os.path.join(FOLDERS['out'], *parts)
