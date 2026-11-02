"""Edit a COPY of a Premiere project from a plan: insert, cut, move, assemble.

insert: at a timecode, every track opens a gap of the insert length (items the
point cuts through are razored; a full-length adjustment layer grows), then each
piece (a file, or a labelled black placeholder) is placed on its track.
cut / move / assemble: see timeline.py; one remap engine does all three and
carries every track, the adjustment layer and the captions along.

usage: python3 -I premiere_insert.py PLAN.json [--project IN.prproj] [--output OUT.prproj]

PLAN.json holds "ops" (or the older "inserts" list, one insert with "pieces", or
a shot file carrying an "insert" object). See README.md.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import uuid

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prproj import Project, TPS, parse_tc, read_text, tc, write_project  # noqa: E402
from validate import check  # noqa: E402
import timeline  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
WRITTEN = os.path.join(HERE, 'written.json')
FILE_IMPORTER = '1fa18bfa-255c-44b1-ad73-56bcd99fceaf'  # Premiere's file importer (mp4, mov, wav, mp3)
STEREO = '[{"channellabel":100},{"channellabel":101}]'
LABELS = {'video': ('BE.Prefs.LabelColors.1', 6769408), 'audio': ('BE.Prefs.LabelColors.2', 480554)}
CLASS = {
    'ClipProjectItem': 'cb4e0ed7-aca1-4171-8525-e3658dec06dd',
    'MasterClip': 'fb11c33a-b0a9-4465-aa94-b6d5db2628cf',
    'ClipLoggingInfo': '77ab7fdd-dcdf-465d-9906-7a330ca1e738',
    'VideoClip': '9308dbef-2440-4acb-9ab2-953b9a4e82ec',
    'AudioClip': 'b8830d03-de02-41ee-84ec-fe566dc70cd9',
    'ClipChannelGroupVectorSerializer': 'a3127a8c-95d4-456e-a7f5-171b3f922426',
    'ClipChannelVectorSerializer': '333d203b-3a53-4195-8894-fc7523ff3dc7',
    'ClipChannelSerializer': '5c89aa7a-89a6-4483-becd-f2b1def42316',
    'AudioComponentChain': '3cb131d1-d3c0-47ae-a19a-bdf75ea11674',
    'VideoComponentChain': '0970e08a-f58f-4108-b29a-1a717b8e12e2',
    'VideoMediaSource': 'e64ddf74-8fac-4682-8aa8-0e0ca2248949',
    'AudioMediaSource': 'f588da05-fc2a-4fbc-9383-74d653b379e3',
    'SecondaryContent': 'f9d004b5-cb04-4e2f-af6f-64fadc2c4be9',
    'Media': '7a5c103e-f3ac-4391-b6b4-7cc3d2f9a7ff',
    'VideoStream': 'a36e4719-3ec6-4a0c-ab11-8b4aab377aa5',
    'AudioStream': '0b5cf52f-2b85-4863-890b-8844b64ecfe9',
    'SubClip': 'e0c58dc9-dbdd-4166-aef7-5db7e3f22e84',
    'VideoClipTrackItem': '368b0406-29e3-4923-9fcd-094fbf9a1089',
    'AudioClipTrackItem': '064ec682-9ba6-11d5-af2d-9ca32c7d6164',
    'Link': '149d4ea5-a7d4-4b34-9bb7-16d783904bf2',
}


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


# ---------------------------------------------------------------- media facts

def probe(path, tpf):
    """Facts Premiere stores for a file, read with ffprobe."""
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    out = json.loads(subprocess.run(
        ['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
        capture_output=True, text=True, check=True).stdout)
    streams = out['streams']
    video = next((s for s in streams if s['codec_type'] == 'video'), None)
    audio = next((s for s in streams if s['codec_type'] == 'audio'), None)
    if video is not None:
        num, den = (int(x) for x in video['r_frame_rate'].split('/'))
        media_tpf = TPS * den // num
        if 'nb_frames' in video:
            frames = int(video['nb_frames'])
        else:
            frames = round(float(video['duration']) * num / den)
        return {'kind': 'video', 'path': path, 'tpf': media_tpf, 'ticks': frames * media_tpf,
                'fourcc': video.get('codec_tag_string', ''), 'width': video['width'], 'height': video['height'],
                'has_audio': audio is not None}
    if audio is None:
        raise ValueError(f'{path}: no video or audio stream')
    if int(audio['channels']) != 2:
        raise ValueError(f'{path}: {audio["channels"]} channels; only stereo audio pieces are supported')
    rate = int(audio['sample_rate'])
    samples = round(float(audio.get('duration') or out['format']['duration']) * rate)
    tps = TPS // rate
    return {'kind': 'audio', 'path': path, 'tps': tps, 'ticks': samples * tps}


FRAME_TOLERANCE = TPS // 2000  # 0.5 ms: audio and video of one render can differ by a few samples


def frames_for(ticks, tpf):
    """Whole frames covering `ticks`; a length within 0.5 ms of a frame boundary counts as that boundary."""
    return -(-(ticks - FRAME_TOLERANCE) // tpf)


def fourcc(code):
    return int.from_bytes(code.encode('latin-1'), 'big') if len(code) == 4 else 0


# ---------------------------------------------------------------- the editor

class Editor:
    def __init__(self, text, sequence_name):
        self.p = Project(text)
        seqs = self.p.sequences()
        if sequence_name:
            seqs = [s for s in seqs if s.findtext('Name') == sequence_name]
        if len(seqs) != 1:
            names = [s.findtext('Name') for s in self.p.sequences()]
            raise ValueError(f'choose one sequence with "sequence"; found {names}')
        self.seq_uid = seqs[0].attrib['ObjectUID']
        self.tracks, self.tpf = self.p.tracks(seqs[0])
        self.root_bin = self.p.ref(self.p.by_id['1'].find('RootProjectItem')).attrib['ObjectUID']
        self.next_id = max(int(i) for i in self.p.by_id) + 1
        self.pending = []
        self.log = []
        self.insert_items = {}  # insert id -> placed track item ids
        self.create_tracks = False

    # -- object helpers
    def oid(self):
        i = self.next_id
        self.next_id += 1
        return str(i)

    def add(self, block):
        self.pending.append(block)

    def flush(self):
        """Write pending objects into the text, before the closing root tag."""
        if self.pending:
            self.p.text = self.p.text.replace('\n</PremiereData>', '\n' + '\n'.join(self.pending) + '\n</PremiereData>')
            self.pending = []
        self.p.reparse()

    def track(self, label):
        if label not in self.tracks:
            videos = sorted(int(k[1:]) for k in self.tracks if k[0] == 'V')
            if self.create_tracks and label[0] == 'V' and int(label[1:]) == videos[-1] + 1:
                self.add_video_track()
            else:
                raise ValueError(f'track {label} does not exist in this sequence; tracks: {sorted(self.tracks)}'
                                 + ('' if self.create_tracks else '; set "create_tracks": true to add the next video track'))
        return self.tracks[label]

    def add_video_track(self):
        """Add one video track on top, the way Premiere writes one: a copy of the top track with the next
        ID and index, no items, untargeted; listed in the track group; one more timeline patch entry."""
        seq = self.p.by_uid[self.seq_uid]
        group = self.p.ref(seq.find('TrackGroups/TrackGroup/Second'))
        rows = group.findall('TrackGroup/Tracks/Track')
        top_uid = rows[-1].attrib['ObjectURef']
        index = len(rows)
        track_id = int(group.findtext('TrackGroup/NextTrackID'))
        uid = str(uuid.uuid4())
        block = self.p.block('ObjectUID', top_uid).replace(f'ObjectUID="{top_uid}"', f'ObjectUID="{uid}"', 1)
        block = re.sub(r'\n\t+<TrackItems Version="1">\n.*?\n\t+</TrackItems>', '', block, count=1, flags=re.S)
        block = re.sub(r'<Index>\d+</Index>', f'<Index>{index}</Index>', block)
        block = re.sub(r'(<Track Version="4">.*?<ID>)\d+(</ID>)', rf'\g<1>{track_id}\g<2>', block, count=1, flags=re.S)
        block = re.sub(r'<MZ.TrackTargeted>\d</MZ.TrackTargeted>', '<MZ.TrackTargeted>0</MZ.TrackTargeted>', block)
        self.p.text = self.p.text.replace('\n</PremiereData>', '\n' + block + '\n</PremiereData>')
        gid = group.attrib['ObjectID']
        self.p.edit('ObjectID', gid, lambda b: re.sub(
            r'(\n(\t+)<Track Index="%d" ObjectURef="%s"/>)' % (index - 1, re.escape(top_uid)),
            rf'\g<1>\n\g<2><Track Index="{index}" ObjectURef="{uid}"/>', b, count=1))
        self.p.edit('ObjectID', gid, lambda b: b.replace(f'<NextTrackID>{track_id}</NextTrackID>',
                                                         f'<NextTrackID>{track_id + 1}</NextTrackID>', 1))

        def patches(b):
            return re.sub(r'(<HSL.TimelinePatchingAndTargeting.VideoPatches[^>]*>\[.*?)(\]</)',
                          lambda m: m.group(1) + ',{"mNumber":-1,"mState":0}' + m.group(2), b, count=1)
        if '<HSL.TimelinePatchingAndTargeting.VideoPatches' in self.p.block('ObjectUID', self.seq_uid):
            self.p.edit('ObjectUID', self.seq_uid, patches)
        self.p.reparse()
        self.tracks, _ = self.p.tracks(self.p.by_uid[self.seq_uid])
        self.log.append(f'  added video track V{index + 1} (track ID {track_id})')

    # -- objects
    def clone(self, oid, mapping):
        """Copy an object and the objects it owns, with fresh ids; media sources,
        markers and master clips stay shared, as Premiere shares them."""
        if oid in mapping:
            return mapping[oid]
        new = self.oid()
        mapping[oid] = new
        for child in self.p.by_id[oid].iter():
            r = child.attrib.get('ObjectRef')
            if r and child.tag not in timeline.SHARED_REF_TAGS:
                self.clone(r, mapping)
        head, body = self.p.block('ObjectID', oid).split('\n', 1)
        head = head.replace(f'ObjectID="{oid}"', f'ObjectID="{new}"', 1)

        def swap(m):
            if m.group(1) in timeline.SHARED_REF_TAGS:
                return m.group(0)
            return f'<{m.group(1)}{m.group(2)} ObjectRef="{mapping[m.group(3)]}"'
        # references may carry other attributes first, e.g. <Component Index="0" ObjectRef="539"/>
        body = re.sub(r'<(\w[\w.]*)((?: [\w.]+="[^"]*")*?) ObjectRef="(\d+)"', swap, body)
        body = re.sub(r'<(ClipID|ID)>[0-9a-f-]{36}</\1>', lambda m: f'<{m.group(1)}>{uuid.uuid4()}</{m.group(1)}>', body)
        self.add(head + '\n' + body)
        return new

    def add_link(self, members):
        link = self.oid()
        rows = ''.join(f'\t\t\t\t<TrackItem Index="{i}" ObjectRef="{m}"/>\n' for i, m in enumerate(members))
        self.add(f'''\t<Link ObjectID="{link}" ClassID="{CLASS['Link']}" Version="1">
\t\t<TrackItemGroup Version="1">
\t\t\t<TrackItems Version="1">
{rows}\t\t\t</TrackItems>
\t\t</TrackItemGroup>
\t</Link>''')
        return link

    # -- importing files
    def black_video_source(self):
        """The project's synthetic Black Video media source (what adjustment layers use)."""
        for el in self.p.by_id.values():
            if el.tag == 'VideoMediaSource':
                media = self.p.ref(el.find('MediaSource/Media'))
                if media is not None and media.findtext('Title') == 'Black Video':
                    return el.attrib['ObjectID']
        raise ValueError('placeholders need Black Video media in the project (add one adjustment layer or black video)')

    def frame_rect(self):
        group = self.p.ref(self.p.by_uid[self.seq_uid].find('TrackGroups/TrackGroup/Second'))
        x0, y0, w, h = (int(v) for v in group.findtext('FrameRect').split(','))
        return w, h

    def import_file(self, facts, label):
        kind = facts['kind']
        if 'placeholder' in facts:
            name = facts['placeholder']
            src = self.black_video_source()
            rate = self.tpf
        else:
            name = os.path.basename(facts['path'])
            src = self.import_media(facts)
            rate = facts['tpf'] if kind == 'video' else facts['tps']
        return self.master_for(kind, name, src, facts['ticks'], rate, label)

    def import_media(self, facts):
        """Media, stream and media source objects for a file. Returns the media source id."""
        kind = facts['kind']
        path = facts['path']
        name = os.path.basename(path)
        media_uid = str(uuid.uuid4())
        if kind == 'video':
            vs = self.oid()
            streams = f'\t\t<VideoStream ObjectRef="{vs}"/>\n'
            self.add(f'''\t<VideoStream ObjectID="{vs}" ClassID="{CLASS['VideoStream']}" Version="23">
\t\t<Duration>{facts['ticks']}</Duration>
\t\t<CodecType>{fourcc(facts['fourcc'])}</CodecType>
\t\t<OriginalImageOrientationType>1</OriginalImageOrientationType>
\t\t<FrameRate>{facts['tpf']}</FrameRate>
\t\t<FrameRect>0,0,{facts['width']},{facts['height']}</FrameRect>
\t</VideoStream>''')
            extra = ''
        else:
            aus = self.oid()
            streams = f'\t\t<AudioStream ObjectRef="{aus}"/>\n'
            self.add(f'''\t<AudioStream ObjectID="{aus}" ClassID="{CLASS['AudioStream']}" Version="8">
\t\t<AudioChannelLayout>{STEREO}</AudioChannelLayout>
\t\t<Duration>{facts['ticks']}</Duration>
\t\t<FrameRate>{facts['tps']}</FrameRate>
\t</AudioStream>''')
            extra = f'\t\t<ConformedAudioRate>{facts["tps"]}</ConformedAudioRate>\n'
        self.add(f'''\t<Media ObjectUID="{media_uid}" ClassID="{CLASS['Media']}" Version="30">
{streams}\t\t<RelativePath>{esc(os.path.relpath(path, self.project_dir))}</RelativePath>
\t\t<ImplementationID>{FILE_IMPORTER}</ImplementationID>
\t\t<FileKey>{uuid.uuid4()}</FileKey>
{extra}\t\t<ActualMediaFilePath>{esc(path)}</ActualMediaFilePath>
\t\t<FilePath>{esc(path)}</FilePath>
\t\t<Title>{esc(name)}</Title>
\t</Media>''')
        src = self.oid()
        stag = 'VideoMediaSource' if kind == 'video' else 'AudioMediaSource'
        self.add(f'''\t<{stag} ObjectID="{src}" ClassID="{CLASS[stag]}" Version="2">
\t\t<MediaSource Version="4">
\t\t\t<Content Version="10">
\t\t\t</Content>
\t\t\t<Media ObjectURef="{media_uid}"/>
\t\t</MediaSource>
\t\t<OriginalDuration>{facts['ticks']}</OriginalDuration>
\t</{stag}>''')
        return src

    def master_for(self, kind, name, src, ticks, rate, label):
        """Logging info, master clip and project item for a media source."""
        log_id = self.oid()
        self.add(f'''\t<ClipLoggingInfo ObjectID="{log_id}" ClassID="{CLASS['ClipLoggingInfo']}" Version="10">
\t\t<ClipName>{esc(name)}</ClipName>
\t\t<MediaInPoint>0</MediaInPoint>
\t\t<MediaOutPoint>{ticks}</MediaOutPoint>
\t\t<MediaFrameRate>{rate}</MediaFrameRate>
\t\t<TimecodeFormat>{110 if kind == 'video' else 200}</TimecodeFormat>
\t</ClipLoggingInfo>''')
        master_clip = self.clip(kind, src, label, None)
        groups = self.oid()
        chains = ''
        if kind == 'audio':
            chan = []
            for ch in (0, 1):
                c = self.oid()
                chan.append(c)
                self.add(f'''\t<ClipChannelSerializer ObjectID="{c}" ClassID="{CLASS['ClipChannelSerializer']}" Version="1">
\t\t<mSourceChannelIndex>{ch}</mSourceChannelIndex>
\t\t<SourceClipIndex>0</SourceClipIndex>
\t</ClipChannelSerializer>''')
            vec = self.oid()
            self.add(f'''\t<ClipChannelVectorSerializer ObjectID="{vec}" ClassID="{CLASS['ClipChannelVectorSerializer']}" Version="1">
\t\t<ClipChannels Version="1">
\t\t\t<ClipChannelItem Index="0" ObjectRef="{chan[0]}"/>
\t\t\t<ClipChannelItem Index="1" ObjectRef="{chan[1]}"/>
\t\t</ClipChannels>
\t\t<ChannelType>1</ChannelType>
\t</ClipChannelVectorSerializer>''')
            self.add(f'''\t<ClipChannelGroupVectorSerializer ObjectID="{groups}" ClassID="{CLASS['ClipChannelGroupVectorSerializer']}" Version="1">
\t\t<ClipChannelVectors Version="1">
\t\t\t<ClipChannelVectorItem Index="0" ObjectRef="{vec}"/>
\t\t</ClipChannelVectors>
\t</ClipChannelGroupVectorSerializer>''')
            chains = (f'\t\t<AudioComponentChains Version="1">\n'
                      f'\t\t\t<AudioComponentChain Index="0" ObjectRef="{self.audio_chain()}"/>\n'
                      f'\t\t</AudioComponentChains>\n')
        else:
            self.add(f'''\t<ClipChannelGroupVectorSerializer ObjectID="{groups}" ClassID="{CLASS['ClipChannelGroupVectorSerializer']}" Version="1">
\t</ClipChannelGroupVectorSerializer>''')
        master_uid = str(uuid.uuid4())
        self.add(f'''\t<MasterClip ObjectUID="{master_uid}" ClassID="{CLASS['MasterClip']}" Version="12">
\t\t<LoggingInfo ObjectRef="{log_id}"/>
{chains}\t\t<Clips Version="1">
\t\t\t<Clip Index="0" ObjectRef="{master_clip}"/>
\t\t</Clips>
\t\t<AudioClipChannelGroups ObjectRef="{groups}"/>
\t\t<Name>{esc(name)}</Name>
\t\t<MasterClipChangeVersion>1</MasterClipChangeVersion>
\t</MasterClip>''')
        order = len(self.p.by_uid[self.root_bin].findall('.//Items/Item')) + self.items_added
        self.items_added += 1
        item_uid = str(uuid.uuid4())
        self.add(f'''\t<ClipProjectItem ObjectUID="{item_uid}" ClassID="{CLASS['ClipProjectItem']}" Version="1">
\t\t<ProjectItem Version="1">
\t\t\t<Node Version="1">
\t\t\t\t<Properties Version="1">
\t\t\t\t\t<project.icon.view.grid.order>{order}</project.icon.view.grid.order>
\t\t\t\t\t<Column.PropertyText.Label>{label[0]}</Column.PropertyText.Label>
\t\t\t\t</Properties>
\t\t\t</Node>
\t\t\t<Name>{esc(name)}</Name>
\t\t</ProjectItem>
\t\t<MasterClip ObjectURef="{master_uid}"/>
\t</ClipProjectItem>''')
        self.bin_items.append(item_uid)
        return {'kind': kind, 'source': src, 'master': master_uid, 'name': name, 'label': label}

    def clip(self, kind, source_id, label, in_out):
        cid = self.oid()
        tag = 'VideoClip' if kind == 'video' else 'AudioClip'
        if in_out:
            points = f'\t\t\t<InPoint>{in_out[0]}</InPoint>\n\t\t\t<OutPoint>{in_out[1]}</OutPoint>\n'
        else:
            points = '\t\t\t<InUse>false</InUse>\n'
        tail = ''
        if kind == 'audio':
            sc = []
            for ch in (0, 1):
                s = self.oid()
                sc.append(s)
                self.add(f'''\t<SecondaryContent ObjectID="{s}" ClassID="{CLASS['SecondaryContent']}" Version="1">
\t\t<Content ObjectRef="{source_id}"/>
\t\t<ChannelIndex>{ch}</ChannelIndex>
\t</SecondaryContent>''')
            tail = (f'\t\t<SecondaryContents Version="1">\n'
                    f'\t\t\t<SecondaryContentItem Index="0" ObjectRef="{sc[0]}"/>\n'
                    f'\t\t\t<SecondaryContentItem Index="1" ObjectRef="{sc[1]}"/>\n'
                    f'\t\t</SecondaryContents>\n\t\t<AudioChannelLayout>{STEREO}</AudioChannelLayout>\n')
        self.add(f'''\t<{tag} ObjectID="{cid}" ClassID="{CLASS[tag]}" Version="{11 if kind == 'video' else 8}">
\t\t<Clip Version="18">
\t\t\t<Node Version="1">
\t\t\t\t<Properties Version="1">
\t\t\t\t\t<asl.clip.label.color>{label[1]}</asl.clip.label.color>
\t\t\t\t\t<asl.clip.label.name>{label[0]}</asl.clip.label.name>
\t\t\t\t</Properties>
\t\t\t</Node>
\t\t\t<Source ObjectRef="{source_id}"/>
\t\t\t<ClipID>{uuid.uuid4()}</ClipID>
{points}\t\t</Clip>
{tail}\t</{tag}>''')
        return cid

    def audio_chain(self):
        a = self.oid()
        self.add(f'''\t<AudioComponentChain ObjectID="{a}" ClassID="{CLASS['AudioComponentChain']}" Version="4">
\t\t<DefaultVol>true</DefaultVol>
\t\t<DefaultVolumeComponentID>1</DefaultVolumeComponentID>
\t\t<DefaultChannelVolumeComponentID>2</DefaultChannelVolumeComponentID>
\t\t<ComponentChain Version="3">
\t\t</ComponentChain>
\t\t<AudioChannelLayout>{STEREO}</AudioChannelLayout>
\t\t<ChannelType>1</ChannelType>
\t</AudioComponentChain>''')
        return a

    def place(self, master, facts, start, length):
        """Put a whole imported file on the timeline at `start` for `length` ticks."""
        kind = master['kind']
        clip = self.clip(kind, master['source'], master['label'], (0, min(length, facts['ticks'])))
        sub = self.oid()
        self.add(f'''\t<SubClip ObjectID="{sub}" ClassID="{CLASS['SubClip']}" Version="6">
\t\t<Clip ObjectRef="{clip}"/>
\t\t<MasterClip ObjectURef="{master['master']}"/>
\t\t<Name>{esc(master['name'])}</Name>
\t\t<OrigChGrp>0</OrigChGrp>
\t</SubClip>''')
        item = self.oid()
        end = start + length
        if kind == 'video':
            chain = self.oid()
            self.add(f'''\t<VideoComponentChain ObjectID="{chain}" ClassID="{CLASS['VideoComponentChain']}" Version="3">
\t\t<DefaultMotion>true</DefaultMotion>
\t\t<DefaultOpacity>true</DefaultOpacity>
\t\t<DefaultMotionComponentID>1</DefaultMotionComponentID>
\t\t<DefaultOpacityComponentID>2</DefaultOpacityComponentID>
\t\t<ComponentChain Version="3">
\t\t</ComponentChain>
\t</VideoComponentChain>''')
            self.add(f'''\t<VideoClipTrackItem ObjectID="{item}" ClassID="{CLASS['VideoClipTrackItem']}" Version="8">
\t\t<ClipTrackItem Version="8">
\t\t\t<ComponentOwner Version="1">
\t\t\t\t<Components ObjectRef="{chain}"/>
\t\t\t</ComponentOwner>
\t\t\t<TrackItem Version="4">
\t\t\t\t<Start>{start}</Start>
\t\t\t\t<End>{end}</End>
\t\t\t</TrackItem>
\t\t\t<SubClip ObjectRef="{sub}"/>
\t\t</ClipTrackItem>
\t\t<ToneMapSettings>{{"peak":-1,"version":3}}</ToneMapSettings>
\t\t<FrameRect>0,0,{facts['width']},{facts['height']}</FrameRect>
\t\t<PixelAspectRatio>1,1</PixelAspectRatio>
\t</VideoClipTrackItem>''')
        else:
            chain = self.audio_chain()
            self.add(f'''\t<AudioClipTrackItem ObjectID="{item}" ClassID="{CLASS['AudioClipTrackItem']}" Version="11">
\t\t<ClipTrackItem Version="8">
\t\t\t<ComponentOwner Version="1">
\t\t\t\t<Components ObjectRef="{chain}"/>
\t\t\t</ComponentOwner>
\t\t\t<TrackItem Version="4">
\t\t\t\t<Start>{start}</Start>
\t\t\t\t<End>{end}</End>
\t\t\t</TrackItem>
\t\t\t<SubClip ObjectRef="{sub}"/>
\t\t</ClipTrackItem>
\t\t<ID>{uuid.uuid4()}</ID>
\t\t<PreRenderComponentChainHashVersion>1</PreRenderComponentChainHashVersion>
\t</AudioClipTrackItem>''')
        return item

    # -- one insert
    def insert(self, ins, at_frame, project_dir):
        self.project_dir = project_dir
        self.items_added = 0
        self.bin_items = []
        tpf = self.tpf
        at = at_frame * tpf
        pieces = []
        for piece in ins['pieces']:
            if 'placeholder' in piece:
                if piece['track'][0] != 'V':
                    raise ValueError(f'placeholder {piece["placeholder"]} must go on a V track')
                frames = frames_for(round(piece['seconds'] * TPS), tpf)
                w, h = self.frame_rect()
                facts = {'kind': 'video', 'placeholder': piece['placeholder'], 'ticks': frames * tpf,
                         'tpf': tpf, 'width': w, 'height': h}
                pieces.append((piece, facts, self.track(piece['track'])))
                continue
            if 'color_space_override' in piece:
                raise ValueError(f'{piece["file"]}: "color_space_override" is not supported. Inserted plates keep '
                                 'Premiere\'s default interpretation, like the camera clips the grade was built on.')
            facts = probe(piece['file'], tpf)
            track_uid = self.track(piece['track'])
            want = 'V' if facts['kind'] == 'video' else 'A'
            if piece['track'][0] != want:
                raise ValueError(f'{piece["file"]} is {facts["kind"]} but track is {piece["track"]}')
            if facts['kind'] == 'video' and facts['tpf'] != tpf:
                raise ValueError(f'{piece["file"]}: frame rate differs from the sequence')
            if facts['kind'] == 'video' and facts['has_audio']:
                raise ValueError(f'{piece["file"]} carries audio; give picture and sound as separate pieces')
            pieces.append((piece, facts, track_uid))
        length_frames = max(frames_for(f['ticks'], tpf) for _, f, _ in pieces)
        by = length_frames * tpf
        self.log.append(f'insert {ins.get("id", "?")}: at {tc(at, tpf)} ({at_frame}f), {length_frames} frames')

        # open a gap of the insert length at `at` on every track (shared remap engine)
        end = timeline.timeline_end(self)
        if at > end:
            raise ValueError(f'insert {ins.get("id")} at {tc(at, tpf)} is after the sequence end {tc(end, tpf)}')
        timeline.remap(self, [r for r in ((0, at, 'before'), (None, by, ins.get('id', 'insert')), (at, end, 'after'))
                              if r[0] is None or r[1] > r[0]])

        placed = []
        for piece, facts, track_uid in pieces:
            master = self.import_file(facts, LABELS[facts['kind']])
            length = frames_for(facts['ticks'], tpf) * tpf
            placed.append((track_uid, self.place(master, facts, at, length), piece, length))
        self.insert_items[ins.get('id', f'insert{len(self.insert_items) + 1}')] = [item for _, item, _, _ in placed]
        self.flush()
        for uid in {u for u, _, _, _ in placed}:
            rows = sorted((s, oid) for oid, s, _, _ in self.p.track_items(uid))
            rows += [(at, item) for u, item, _, _ in placed if u == uid]
            timeline.set_track_list(self, uid, [oid for _, oid in sorted(rows)])
        for uid, item, piece, length in placed:
            what = piece.get('placeholder') or os.path.basename(piece['file'])
            self.log.append(f'  {piece["track"]}: {what} {tc(at, tpf)} -> {tc(at + length, tpf)}')
        for item_uid in self.bin_items:
            self.p.edit('ObjectUID', self.root_bin, lambda b, u=item_uid: add_bin_item(b, u))
        self.p.reparse()
        return length_frames





def add_bin_item(block, uid):
    n = len(re.findall(r'<Item Index=', block))
    return block.replace('\t\t\t</Items>', f'\t\t\t\t<Item Index="{n}" ObjectURef="{uid}"/>\n\t\t\t</Items>', 1)


# ---------------------------------------------------------------- plan + output

def load_plan(path):
    plan = json.load(open(path))
    if 'ops' in plan:
        return plan
    if 'inserts' in plan:
        return {**plan, 'ops': [{'op': 'insert', **i} for i in plan['inserts']]}
    if 'insert' in plan:
        return {'ops': [{'op': 'insert', **plan['insert']}],
                **{k: v for k, v in plan.items() if k in ('project', 'output', 'sequence')}}
    if 'pieces' in plan:
        return {'ops': [{'op': 'insert', **plan}]}
    raise ValueError(f'{path}: needs "ops", "inserts", "insert" or "pieces"')


def point(ed, value):
    """A position: timecode, frame number, {"after": range} or {"before": range} -> ticks."""
    if isinstance(value, dict):
        a, b, _ = timeline.resolve(ed, value.get('after') or value.get('before'))
        return b if 'after' in value else a
    return parse_tc(value, ed.tpf) * ed.tpf


def run_ops(ed, plan, project_dir):
    """Apply the plan's ops in order."""
    tpf = ed.tpf
    original_times = plan.get('timecodes', 'original') == 'original'
    applied, structural = [], False
    for op in plan['ops']:
        kind = op['op']
        if kind == 'insert':
            frame = parse_tc(op['at'], tpf) if not isinstance(op['at'], dict) else point(ed, op['at']) // tpf
            if original_times and not isinstance(op['at'], dict):
                if structural:
                    raise ValueError(f'insert {op.get("id")}: original timecodes cannot follow a cut, move or '
                                     'assemble; give "at" as {"after": range} or use "timecodes": "current"')
                frame += sum(n for f, n in applied if f <= frame)
            length = ed.insert(op, frame, project_dir)
            applied.append((parse_tc(op['at'], tpf) if not isinstance(op['at'], dict) else frame, length))
        elif kind == 'cut':
            a, b, _ = timeline.resolve(ed, op['range'])
            ed.log.append(f'cut {op.get("id", "")}: {tc(a, tpf)} -> {tc(b, tpf)}')
            timeline.cut(ed, a, b)
            structural = True
        elif kind == 'move':
            a, b, _ = timeline.resolve(ed, op['range'])
            to = point(ed, op['to'])
            ed.log.append(f'move {op.get("id", "")}: {tc(a, tpf)} -> {tc(b, tpf)} to {tc(to, tpf)}')
            timeline.move(ed, a, b, to)
            structural = True
        elif kind == 'assemble':
            ed.log.append(f'assemble {op.get("id", "")}: {len(op["entries"])} entries')
            timeline.assemble(ed, op['entries'])
            structural = True
        else:
            raise ValueError(f'unknown op {kind}')


def b3(path):
    return subprocess.run(['b3sum', '--no-names', path], capture_output=True, text=True, check=True).stdout.strip()


def written_record():
    return json.load(open(WRITTEN)) if os.path.exists(WRITTEN) else {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('plan')
    ap.add_argument('--project')
    ap.add_argument('--output')
    args = ap.parse_args()
    plan = load_plan(args.plan)
    src = os.path.abspath(args.project or plan['project'])
    dst = os.path.abspath(args.output or plan['output'])
    if src == dst:
        sys.exit('refused: output must be a new file, never the input project')
    record = written_record()
    if os.path.exists(dst) and record.get(dst) != b3(dst):
        sys.exit(f'refused: {dst} exists and is not the file this tool last wrote (someone may have edited it)')

    original = read_text(src)
    ed = Editor(original, plan.get('sequence'))
    ed.create_tracks = bool(plan.get('create_tracks'))
    run_ops(ed, plan, os.path.dirname(dst))
    # a new project identity, so the copy can be open next to the original
    ed.p.text = re.sub(r'<MZ.Project.GUID>[0-9a-f-]+</MZ.Project.GUID>',
                       f'<MZ.Project.GUID>{uuid.uuid4()}</MZ.Project.GUID>', ed.p.text, count=1)
    end = timeline.timeline_end(ed)
    ed.p.text = re.sub(r'<Monitor.ProgramZoomOut>\d+</Monitor.ProgramZoomOut>',
                       f'<Monitor.ProgramZoomOut>{end}</Monitor.ProgramZoomOut>', ed.p.text, count=1)
    problems = check(ed.p.text)
    base = set(check(original))
    new_problems = [x for x in problems if x not in base]
    print('\n'.join(ed.log))
    if new_problems:
        sys.exit('NOT WRITTEN, the result fails checks:\n' + '\n'.join(new_problems))
    if os.path.exists(dst):
        subprocess.run(['trash', dst], check=True)
    tmp = dst + '.writing'
    write_project(tmp, ed.p.text)
    if read_text(tmp) != ed.p.text:
        sys.exit('NOT WRITTEN: gzip round trip differs')
    shutil.move(tmp, dst)
    record[dst] = b3(dst)
    json.dump(record, open(WRITTEN, 'w'), indent=1)
    print(f'checks passed; wrote {dst}')


if __name__ == '__main__':
    main()
