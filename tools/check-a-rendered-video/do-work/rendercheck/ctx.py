"""One video's context: spec, discovered overlay + timeline, time maps and lazily loaded frames, audio and words."""
import hashlib
import importlib.util
import os
import tempfile

import numpy as np

from . import jsonio, media


def dotted(d, path):
    """Values at a dotted path; 'rows.text' walks a list and yields every item's text."""
    cur = [d]
    for part in path.split('.'):
        nxt = []
        for c in cur:
            if isinstance(c, list):
                nxt += [x.get(part) for x in c if isinstance(x, dict) and part in x]
            elif isinstance(c, dict) and part in c:
                nxt.append(c[part])
        cur = nxt
    return [x for x in cur if x is not None]


def as_list(v):
    """An edit entry that is one dict or a list of them (hold, hold_picture), as a list (fc_preview_r3 takes either)."""
    return [] if not v else v if isinstance(v, list) else [v]


def _nested_at(value):
    """Every numeric `at` / `draw_at` inside an event's child elements (branch_map root and leaves, callout labels, axis_reframe ends):
    an event timed only by its children appears when its first child does."""
    out = []
    if isinstance(value, dict):
        for k, v in value.items():
            if k in ('at', 'draw_at') and isinstance(v, (int, float)) and not isinstance(v, bool):
                out.append(float(v))
            else:
                out += _nested_at(v)
    elif isinstance(value, list):
        for v in value:
            out += _nested_at(v)
    return out


class Context:
    def __init__(self, preview, spec, cfg, overlay=None, timeline=None, words=None, source_words=None, recipe=None, cache_dir=None):
        self.preview = os.path.abspath(preview)
        self.spec = spec or {}
        self.cfg = cfg
        self.info = media.probe(self.preview)
        self.fps = self.info['fps']
        self.edit = self.spec.get('edit', {})
        self.p0 = (self.edit.get('preview') or [0.0, self.info['duration']])[0]
        self.overlay = overlay or self._find_overlay()
        self.timeline = self._load_timeline(timeline)
        self.plain = not self.overlay and not self.spec.get('events')      # nothing laid over the footage: the joins and word clips still apply; overlay-only checks are an empty set
        self.cache_dir = cache_dir or os.path.join(tempfile.gettempdir(), 'check-a-rendered-video-cache')
        self.words_path = words
        self.source_words = self._load_source_words(source_words)
        self.recipe = recipe
        self._cache = {}

    # ---- discovery
    def _find_overlay(self):
        given = self.spec.get('overlay_file')
        if not given:
            return None
        path = given if os.path.isabs(given) else os.path.join(os.path.dirname(self.preview), given)
        return path if os.path.exists(path) else None

    def _load_timeline(self, path):
        path = path or (os.path.join(os.path.dirname(self.overlay), self.cfg['analysis']['timeline_name']) if self.overlay else None)
        return jsonio.read(path) if path and os.path.exists(path) else None

    def _load_source_words(self, path):
        path = path or self.spec.get('source_words')
        if not path:
            return None
        data = jsonio.read(path)
        data = data['words'] if isinstance(data, dict) else data
        # the source footage's word lists come as {w,s,e} (whisper) or {text,start,end} (Parakeet, with blank tokens for gaps)
        return [{'w': (x.get('w') or x.get('text')).strip(), 's': x.get('s', x.get('start')), 'e': x.get('e', x.get('end'))} for x in data if (x.get('w') or x.get('text') or '').strip()]

    # ---- time maps
    @property
    def overlay_t0(self):
        """Preview second at which the overlay's first frame plays."""
        at = (self.edit.get('overlay') or {}).get('at')
        return None if at is None else at - self.p0

    def element_start(self, ev):
        """Seconds from the overlay's first frame at which the event appears, or None when unresolved."""
        at = ev.get('at')
        if isinstance(at, (int, float)):
            return float(at)
        if self.timeline:
            for el in self.timeline.get('elements', []):
                if el['id'] == ev.get('id') or el['id'] == self.cfg['analysis'].get('timeline_id_aliases', {}).get(ev.get('type')):
                    return float(el['at'])
            # an event timed by word anchors (`at: ["thirty", 0.0]`) has numeric starts only in the timeline, under its children's ids (<event id>-label0, ...)
            kids = [float(el['at']) for el in self.timeline.get('elements', []) if ev.get('id') and el['id'].startswith(str(ev['id']) + '-')]
            if kids:
                return min(kids)
        nested = _nested_at(ev)
        return min(nested) if nested else None

    def prepend_segments(self):
        """[(start, end, a)] of the stitched cold open (edit.prepend): each listed range [a, b] of the source footage plays at start..end of the sequence, in the order listed;
        the rest of the video follows from `end` of the last one."""
        out, at = [], 0.0
        for a, b in self.edit.get('prepend') or []:
            out.append((at, at + b - a, float(a)))
            at += b - a
        return out

    def _stitch_source(self, s):
        """Second of the source footage at a stitched-sequence second (cuts already undone): inside the stitched part its range, after it the rest of the video shifted by the stitched length."""
        segs = self.prepend_segments()
        for start, end, a in segs:
            if s < end:
                return a + s - start
        return s - segs[-1][1] if segs else s

    def _cut_source(self, edited):
        """Second of the source footage at an edited-sequence time (before any hold), undoing the ripple-deleted cuts (counted from the start of the stitched
        sequence, as fc_preview does: prepend runs first) and then the stitched cold open."""
        removed = 0.0
        for a, b in sorted(self.edit.get('cuts', [])):
            if edited + removed >= a:
                removed += b - a
        return self._stitch_source(edited + removed)

    def source_spans(self):
        """[(a, b)] ranges of the source footage that edit.preview plays (cuts and hold aside): the range itself, or with a stitched cold open the pieces it covers."""
        a, b = self.edit['preview']
        segs = self.prepend_segments()
        if not segs:
            return [(a, b)]
        out = [(src + max(a, s) - s, src + min(b, e) - s) for s, e, src in segs if min(b, e) > max(a, s)]
        if b > segs[-1][1]:
            out.append((max(a, segs[-1][1]) - segs[-1][1], b - segs[-1][1]))
        return out

    def holds(self):
        """edit.hold (one dict or a list of them) as a list sorted by `at`; each `at` is an edited-sequence time before any hold (fc_preview inserts them latest first)."""
        return sorted(as_list(self.edit.get('hold')), key=lambda h: h['at'])

    def hold_pictures(self):
        """edit.hold_picture (one dict or a list of them) as a list; each `at` is a time after all holds."""
        return as_list(self.edit.get('hold_picture'))

    def held_before(self, e):
        """Seconds of hold inserted at or before edited-sequence time e (before any hold): what plays at e plays this much later."""
        return sum(float(h['seconds']) for h in self.holds() if h['at'] <= e)

    def hold_spans(self):
        """[(start, seconds, at)] of every hold, ascending: it starts at its `at` plus the seconds of the holds before it (a time after all holds)
        and freezes the frame at `at` (a time before any hold)."""
        out, shift = [], 0.0
        for h in self.holds():
            out.append((h['at'] + shift, float(h['seconds']), h['at']))
            shift += float(h['seconds'])
        return out

    def joins(self):
        """Every cut, hold entry and hold exit as dicts: t (preview s), kind, src_end/src_start (source-footage seconds
        where the speech of the source footage stops / resumes at that join)."""
        out = []
        removed = 0.0
        for a, b in sorted(self.edit.get('cuts', [])):
            e = a - removed
            out.append({'t': e + self.held_before(e) - self.p0, 'kind': 'cut',
                        'src_end': self._stitch_source(a), 'src_start': self._stitch_source(b)})
            removed += b - a
        for start, end, a in self.prepend_segments():      # each stitch point: the piece ends, the next piece (or the rest of the video, from its first second) begins
            out.append({'t': end + self.held_before(end) - self.p0, 'kind': 'cut',
                        'src_end': a + end - start, 'src_start': self._cut_source(end)})
        for start, secs, at in self.hold_spans():
            src = self._cut_source(at)
            out.append({'t': start - self.p0, 'kind': 'hold-entry', 'src_end': src, 'src_start': None})
            out.append({'t': start + secs - self.p0, 'kind': 'hold-exit', 'src_end': None, 'src_start': src})
        return sorted(out, key=lambda j: j['t'])

    def source_time(self, preview_t):
        """Second of the source footage that plays at preview_t (a hold plays its entry frame; after a hold the footage is later by its seconds)."""
        e = preview_t + self.p0
        shift = 0.0
        for start, secs, at in self.hold_spans():
            if e < start:
                break
            if e < start + secs:
                return self._cut_source(at)
            shift += secs
        return self._cut_source(e - shift)

    # ---- lazy data
    def overlay_alpha(self):
        if 'alpha' not in self._cache:
            c = self.cfg['analysis']
            self._cache['alpha'] = media.alpha_frames(self.overlay, c['overlay_width'], c['overlay_height'])
        return self._cache['alpha']

    def overlay_fps(self):
        return media.probe(self.overlay)['fps']

    def audio(self):
        if 'audio' not in self._cache:
            self._cache['audio'] = media.audio(self.preview) if self.info['has_audio'] else (np.zeros(0, np.float32), 16000)
        return self._cache['audio']

    def _words_cache_path(self):
        st = os.stat(self.preview)
        key = hashlib.blake2b(f'{self.preview}:{st.st_size}:{st.st_mtime_ns}'.encode(), digest_size=8).hexdigest()
        os.makedirs(self.cache_dir, exist_ok=True)
        return os.path.join(self.cache_dir, f'{os.path.splitext(os.path.basename(self.preview))[0]}-{key}.words.json')

    def can_get_words(self):
        """True when word timings are given, cached, or mlx-whisper is installed to make them."""
        return bool(self.words_path) or os.path.exists(self._words_cache_path()) or importlib.util.find_spec('mlx_whisper') is not None

    def words_if_present(self):
        """The preview's word timings when they are already given or cached; None otherwise (never starts a transcription)."""
        if self.words_path or os.path.exists(self._words_cache_path()):
            return self.preview_words()
        return None

    def preview_words(self):
        """Whisper word timings of the video, cached by path, file size and mtime in the cache folder."""
        if 'words' in self._cache:
            return self._cache['words']
        if self.words_path:
            data = jsonio.read(self.words_path)
        else:
            path = self._words_cache_path()
            if os.path.exists(path):
                data = jsonio.read(path)
            else:
                import mlx_whisper
                r = mlx_whisper.transcribe(self.preview, path_or_hf_repo=self.cfg['word_clip']['whisper_model'],
                                           word_timestamps=True, condition_on_previous_text=False)
                data = [{'w': w['word'].strip(), 's': w['start'], 'e': w['end']} for s in r['segments'] for w in s['words']]
                jsonio.write(path, data)
        data = [{**w, 'w': self._spelled(w['w'])} for w in data]
        self._cache['words'] = data
        return data

    def _spelled(self, word):
        """Names the speech-to-text mishears, corrected from config word_clip.spelling_fixes ({heard: right}); punctuation is kept."""
        fixes = self.cfg['word_clip'].get('spelling_fixes', {})
        core = word.strip('.,?!;:"\'')
        fix = {k.lower(): v for k, v in fixes.items()}.get(core.lower())
        return word.replace(core, fix, 1) if fix else word
