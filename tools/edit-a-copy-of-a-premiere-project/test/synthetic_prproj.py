"""Build a small, made-up Premiere project (gzipped XML) for the tests.

It has only what the tool reads: a project object with its root bin, one 23.976 sequence with tracks V1, V2, A1 and
A2, and on V1/A1 linked picture and sound items cut from two made-up recordings. A "Black Video" media source is there
for placeholders. Every clip name, path and number here is invented.
"""
import gzip
import uuid

TPS = 254016000000
TPF = TPS * 1001 // 24000  # one frame at 23.976
TPS_AUDIO = TPS // 48000

CLIPS = {'A001.mov': 'cafe-a001', 'A002.mov': 'cafe-a002'}


class Builder:
    def __init__(self):
        self.next = 2
        self.objects = []

    def oid(self):
        n = self.next
        self.next += 1
        return str(n)

    def add(self, text):
        self.objects.append(text)


def build(layout=None, links=True, black_video=True):
    """layout: [(clip name, source in seconds, length seconds)] in timeline order on V1 (and A1)."""
    layout = layout or [('A001.mov', 0.0, 10.0), ('A002.mov', 5.0, 10.0)]
    b = Builder()
    media_src = {}
    for name, uid in CLIPS.items():
        media_uid = f'{uid}-0000-4000-8000-000000000001'
        b.add(f'''\t<Media ObjectUID="{media_uid}" ClassID="m" Version="30">
\t\t<FilePath>/made-up/{name}</FilePath>
\t\t<Title>{name}</Title>
\t</Media>''')
        vs, as_ = b.oid(), b.oid()
        for sid, tag in ((vs, 'VideoMediaSource'), (as_, 'AudioMediaSource')):
            b.add(f'''\t<{tag} ObjectID="{sid}" ClassID="s" Version="2">
\t\t<MediaSource Version="4">
\t\t\t<Media ObjectURef="{media_uid}"/>
\t\t</MediaSource>
\t</{tag}>''')
        master = f'{uid}-0000-4000-8000-000000000002'
        # the master clip's own clips keep the media sources referenced when no timeline item uses them
        mv, ma = b.oid(), b.oid()
        for cid, tag, sid in ((mv, 'VideoClip', vs), (ma, 'AudioClip', as_)):
            b.add(f'''\t<{tag} ObjectID="{cid}" ClassID="c" Version="11">
\t\t<Clip Version="18">
\t\t\t<Source ObjectRef="{sid}"/>
\t\t\t<ClipID>{uuid.uuid4()}</ClipID>
\t\t\t<InUse>false</InUse>
\t\t</Clip>
\t</{tag}>''')
        b.add(f'''\t<MasterClip ObjectUID="{master}" ClassID="mc" Version="12">
\t\t<Clips Version="1">
\t\t\t<Clip Index="0" ObjectRef="{mv}"/>
\t\t\t<Clip Index="1" ObjectRef="{ma}"/>
\t\t</Clips>
\t\t<Name>{name}</Name>
\t</MasterClip>''')
        media_src[name] = (vs, as_, master)
    if black_video:
        b.add('''\t<Media ObjectUID="b1ac0000-0000-4000-8000-000000000001" ClassID="m" Version="30">
\t\t<Title>Black Video</Title>
\t</Media>''')
        bv = b.oid()
        b.add(f'''\t<VideoMediaSource ObjectID="{bv}" ClassID="s" Version="2">
\t\t<MediaSource Version="4">
\t\t\t<Media ObjectURef="b1ac0000-0000-4000-8000-000000000001"/>
\t\t</MediaSource>
\t</VideoMediaSource>''')

    def item(kind, name, start, end, src_in):
        vs, as_, master = media_src[name]
        clip, sub, it = b.oid(), b.oid(), b.oid()
        tag = 'VideoClip' if kind == 'video' else 'AudioClip'
        b.add(f'''\t<{tag} ObjectID="{clip}" ClassID="c" Version="11">
\t\t<Clip Version="18">
\t\t\t<Source ObjectRef="{vs if kind == 'video' else as_}"/>
\t\t\t<ClipID>{uuid.uuid4()}</ClipID>
\t\t\t<InPoint>{src_in}</InPoint>
\t\t\t<OutPoint>{src_in + end - start}</OutPoint>
\t\t</Clip>
\t</{tag}>''')
        b.add(f'''\t<SubClip ObjectID="{sub}" ClassID="sc" Version="6">
\t\t<Clip ObjectRef="{clip}"/>
\t\t<MasterClip ObjectURef="{master}"/>
\t\t<Name>{name}</Name>
\t</SubClip>''')
        itag = 'VideoClipTrackItem' if kind == 'video' else 'AudioClipTrackItem'
        start_row = f'\t\t\t\t<Start>{start}</Start>\n' if start else ''
        b.add(f'''\t<{itag} ObjectID="{it}" ClassID="ti" Version="8">
\t\t<ClipTrackItem Version="8">
\t\t\t<TrackItem Version="4">
{start_row}\t\t\t\t<End>{end}</End>
\t\t\t</TrackItem>
\t\t\t<SubClip ObjectRef="{sub}"/>
\t\t</ClipTrackItem>
\t</{itag}>''')
        return it

    v1, a1, link_ids = [], [], []
    pos = 0
    for name, src_in, seconds in layout:
        length = round(seconds * 24000 / 1001) * TPF
        cin = round(src_in * 24000 / 1001) * TPF
        v = item('video', name, pos, pos + length, cin)
        a = item('audio', name, pos, pos + length, cin)
        v1.append(v)
        a1.append(a)
        if links:
            lid = b.oid()
            b.add(f'''\t<Link ObjectID="{lid}" ClassID="l" Version="1">
\t\t<TrackItemGroup Version="1">
\t\t\t<TrackItems Version="1">
\t\t\t\t<TrackItem Index="0" ObjectRef="{v}"/>
\t\t\t\t<TrackItem Index="1" ObjectRef="{a}"/>
\t\t\t</TrackItems>
\t\t</TrackItemGroup>
\t</Link>''')
            link_ids.append(lid)
        pos += length

    def track(tag, uid, index, ids):
        rows = ''.join(f'\t\t\t\t\t<TrackItem Index="{i}" ObjectRef="{o}"/>\n' for i, o in enumerate(ids))
        listing = f'\t\t\t\t<TrackItems Version="1">\n{rows}\t\t\t\t</TrackItems>\n' if ids else ''
        b.add(f'''\t<{tag} ObjectUID="{uid}" ClassID="t" Version="1">
\t\t<ClipTrack Version="1">
\t\t\t<ClipItems Version="3">
{listing}\t\t\t</ClipItems>
\t\t\t<Track Version="4">
\t\t\t\t<ID>{index + 1}</ID>
\t\t\t\t<Index>{index}</Index>
\t\t\t\t<MZ.TrackTargeted>1</MZ.TrackTargeted>
\t\t\t</Track>
\t\t</ClipTrack>
\t</{tag}>''')

    uids = {k: f'7ac0000{n}-0000-4000-8000-000000000000' for n, k in enumerate(('V1', 'V2', 'A1', 'A2'))}
    track('VideoClipTrack', uids['V1'], 0, v1)
    track('VideoClipTrack', uids['V2'], 1, [])
    track('AudioClipTrack', uids['A1'], 0, a1)
    track('AudioClipTrack', uids['A2'], 1, [])
    vg, ag = b.oid(), b.oid()
    b.add(f'''\t<VideoTrackGroup ObjectID="{vg}" ClassID="g" Version="1">
\t\t<TrackGroup Version="1">
\t\t\t<Tracks Version="1">
\t\t\t\t<Track Index="0" ObjectURef="{uids['V1']}"/>
\t\t\t\t<Track Index="1" ObjectURef="{uids['V2']}"/>
\t\t\t</Tracks>
\t\t\t<FrameRate>{TPF}</FrameRate>
\t\t\t<NextTrackID>3</NextTrackID>
\t\t</TrackGroup>
\t\t<FrameRect>0,0,640,360</FrameRect>
\t</VideoTrackGroup>''')
    b.add(f'''\t<AudioTrackGroup ObjectID="{ag}" ClassID="g" Version="1">
\t\t<TrackGroup Version="1">
\t\t\t<Tracks Version="1">
\t\t\t\t<Track Index="0" ObjectURef="{uids['A1']}"/>
\t\t\t\t<Track Index="1" ObjectURef="{uids['A2']}"/>
\t\t\t</Tracks>
\t\t\t<FrameRate>{TPS_AUDIO}</FrameRate>
\t\t\t<NextTrackID>3</NextTrackID>
\t\t</TrackGroup>
\t</AudioTrackGroup>''')
    link_rows = ''.join(f'\t\t\t\t\t<Link Index="{i}" ObjectRef="{lid}"/>\n' for i, lid in enumerate(link_ids))
    b.add(f'''\t<Sequence ObjectUID="5e90000-0000-4000-8000-000000000000" ClassID="q" Version="11">
\t\t<Node Version="1">
\t\t\t<Properties Version="1">
\t\t\t\t<Links Version="1">
{link_rows}\t\t\t\t</Links>
\t\t\t</Properties>
\t\t</Node>
\t\t<TrackGroups Version="1">
\t\t\t<TrackGroup Index="0">
\t\t\t\t<Second ObjectRef="{vg}"/>
\t\t\t</TrackGroup>
\t\t\t<TrackGroup Index="1">
\t\t\t\t<Second ObjectRef="{ag}"/>
\t\t\t</TrackGroup>
\t\t</TrackGroups>
\t\t<Name>Main cut</Name>
\t</Sequence>''')
    bin_uid = 'b1110000-0000-4000-8000-000000000000'
    b.add(f'''\t<RootProjectItem ObjectUID="{bin_uid}" ClassID="r" Version="1">
\t\t<ProjectItemContainer Version="1">
\t\t\t<Items Version="1">
\t\t\t\t<Item Index="0" ObjectURef="{media_src['A001.mov'][2]}"/>
\t\t\t</Items>
\t\t</ProjectItemContainer>
\t</RootProjectItem>''')
    project = f'''\t<Project ObjectID="1" ClassID="p" Version="40">
\t\t<RootProjectItem ObjectURef="{bin_uid}"/>
\t\t<MZ.Project.GUID>{uuid.uuid4()}</MZ.Project.GUID>
\t\t<Monitor.ProgramZoomOut>{pos}</Monitor.ProgramZoomOut>
\t</Project>'''
    return '<?xml version="1.0" encoding="UTF-8" ?>\n<PremiereData Version="3">\n' + \
        '\n'.join([project] + b.objects) + '\n</PremiereData>\n'


def write(path, **kw):
    text = build(**kw)
    with open(path, 'wb') as f:
        f.write(gzip.compress(text.encode('utf-8')))
    return text
