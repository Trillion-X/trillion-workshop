"""Read and write Premiere Pro project files (.prproj = gzipped XML).

Shared by premiere_insert.py, prdump.py and validate.py.
"""
import gzip
import re
import xml.etree.ElementTree as ET

TPS = 254016000000  # Premiere ticks per second


def read_text(path):
    raw = open(path, 'rb').read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return raw.decode('utf-8')


def write_project(path, text):
    with open(path, 'wb') as f:
        f.write(gzip.compress(text.encode('utf-8')))


class Project:
    """Parsed view over the project text. Edits go to `text`; call reparse() after each."""

    def __init__(self, text):
        self.text = text
        self.reparse()

    def reparse(self):
        root = ET.fromstring(self.text)
        self.root = root
        self.by_id = {e.attrib['ObjectID']: e for e in root if 'ObjectID' in e.attrib}
        self.by_uid = {e.attrib['ObjectUID']: e for e in root if 'ObjectUID' in e.attrib}

    def ref(self, el):
        if el is None:
            return None
        if 'ObjectRef' in el.attrib:
            return self.by_id[el.attrib['ObjectRef']]
        if 'ObjectURef' in el.attrib:
            return self.by_uid[el.attrib['ObjectURef']]
        return None

    # ---- text span of a top-level object
    def span(self, attr, value):
        m = re.search(r'\n\t<(\w[\w.]*) %s="%s"[^>]*>.*?\n\t</\1>' % (attr, re.escape(value)), self.text, re.S)
        if not m:
            raise KeyError(f'{attr}={value}')
        return m.start() + 1, m.end()

    def block(self, attr, value):
        s, e = self.span(attr, value)
        return self.text[s:e]

    def edit(self, attr, value, fn):
        s, e = self.span(attr, value)
        old = self.text[s:e]
        new = fn(old)
        if new == old:
            raise RuntimeError(f'edit of {attr}={value} changed nothing')
        self.text = self.text[:s] + new + self.text[e:]

    # ---- sequences and tracks
    def sequences(self):
        return [e for e in self.root if e.tag == 'Sequence' and 'ObjectUID' in e.attrib]

    def tracks(self, seq):
        """{'V1': uid, 'A1': uid, ..., 'D1': uid} plus the video ticks per frame."""
        out, tpf = {}, None
        for tg in seq.findall('TrackGroups/TrackGroup'):
            group = self.ref(tg.find('Second'))
            letter = {'VideoTrackGroup': 'V', 'AudioTrackGroup': 'A'}.get(group.tag, 'D')
            if letter == 'V':
                tpf = int(group.findtext('TrackGroup/FrameRate'))
            for t in group.findall('TrackGroup/Tracks/Track'):
                out[f'{letter}{int(t.attrib["Index"]) + 1}'] = t.attrib['ObjectURef']
        return out, tpf

    def track_items(self, track_uid):
        """[(item_id, start_ticks, end_ticks, ClipTrackItem element)] in list order."""
        track = self.by_uid[track_uid]
        out = []
        for it in track.findall('.//ClipItems/TrackItems/TrackItem'):
            item = self.by_id[it.attrib['ObjectRef']]
            cti = clip_track_item(item)
            ti = cti.find('TrackItem')
            out.append((it.attrib['ObjectRef'], int(ti.findtext('Start') or 0), int(ti.findtext('End')), cti))
        return out

    def item_name(self, cti):
        sub = self.ref(cti.find('SubClip'))
        if sub is None:
            return '?'
        name = sub.findtext('Name') or '?'
        return name

    def is_adjustment_layer(self, cti):
        sub = self.ref(cti.find('SubClip'))
        if sub is None:
            return False
        master = self.ref(sub.find('MasterClip'))
        return master is not None and master.findtext('IsAdjustmentLayer') == 'true'


def clip_track_item(item):
    cti = item.find('ClipTrackItem')
    if cti is None:
        cti = item.find('DataClipTrackItem/ClipTrackItem')
    return cti


def nominal_fps(tpf):
    return round(TPS / tpf)


def tc(ticks, tpf):
    """Non-drop timecode, as Premiere shows 23.976 (24 frame labels per second)."""
    fps = nominal_fps(tpf)
    f = ticks // tpf
    s, fr = divmod(f, fps)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f'{h:02d}:{m:02d}:{s:02d}:{fr:02d}'


def parse_tc(value, tpf):
    """'HH:MM:SS:FF' (non-drop) or an int frame count -> frame number."""
    if isinstance(value, int):
        return value
    h, m, s, f = (int(x) for x in re.split(r'[:;]', value))
    if ';' in value:
        raise ValueError(f'drop-frame timecode {value} is not supported')
    fps = nominal_fps(tpf)
    if f >= fps:
        raise ValueError(f'timecode {value}: frame {f} >= {fps}')
    return ((h * 60 + m) * 60 + s) * fps + f
