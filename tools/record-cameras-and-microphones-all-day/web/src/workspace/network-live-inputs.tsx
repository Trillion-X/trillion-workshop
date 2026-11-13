import * as React from 'react';
import { Badge, Button, Card, Container, Text } from '../../parts/ui';
import { MediaFrame } from '../../parts/ui/show/media-frame/MediaFrame';
import { files, readJson, readListing } from './api';

type NetworkSource = { id: string; kind: 'hls'; label: string; playback_url: string; clips_folder: string; connection?: string; ingest_url?: string };
type SourceFile = { encoding: string; content: string };
type ClipListing = { names: { name: string; identity: string; stored: boolean }[] };

const sourceFile = '/Camera/live-sources.json';
const keyPath = (id: string) => `/work/api/cameras/${encodeURIComponent(id)}/key`;

function LivePicture({ source }: { source: NetworkSource }) {
  const video = React.useRef<HTMLVideoElement>(null);
  const [online, setOnline] = React.useState(false);

  React.useEffect(() => {
    const player = video.current;
    if (!player) return undefined;
    const playing = () => setOnline(true);
    const stopped = () => setOnline(false);
    player.addEventListener('playing', playing);
    player.addEventListener('error', stopped);
    player.addEventListener('stalled', stopped);
    const unlisten = () => { player.removeEventListener('playing', playing); player.removeEventListener('error', stopped); player.removeEventListener('stalled', stopped); };
    // A browser that plays HLS itself (Safari) takes the address; any other fetches hls.js when a camera is shown,
    // so the screen's own file stays within its budget (scripts/workspace-budgets.json).
    if (player.canPlayType('application/vnd.apple.mpegurl')) {
      player.src = source.playback_url;
      return () => { player.removeAttribute('src'); player.load(); unlisten(); };
    }
    let hls: { destroy(): void } | null = null;
    let left = false;
    void import('hls.js').then(({ default: Hls }) => {
      if (left || !Hls.isSupported()) return;
      const made = new Hls({ liveSyncDurationCount: 3 });
      made.loadSource(source.playback_url);
      made.attachMedia(player);
      made.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) setOnline(false); });
      hls = made;
    }).catch(() => setOnline(false));
    return () => { left = true; hls?.destroy(); unlisten(); };
  }, [source.playback_url]);

  return <>
    <Container position="relative" style={{ aspectRatio: '16 / 9' }} background="overlay">
      <MediaFrame mediaType="video/mp4" label={source.label} videoRef={video} muted autoPlay playsInline fill />
      <Container position="absolute" className="start-2 top-2"><Badge variant={online ? 'destructive' : 'secondary'}>{online ? 'Live' : 'Waiting for camera'}</Badge></Container>
    </Container>
  </>;
}

export function NetworkLiveInputs() {
  const [sources, setSources] = React.useState<NetworkSource[]>([]);
  const [clips, setClips] = React.useState<Record<string, { name: string; identity: string } | null>>({});
  const [copied, setCopied] = React.useState<string | null>(null);
  // The ingest key leaves the Worker only into the clipboard of the signed-in page; it is never drawn.
  const copyKey = async (id: string) => {
    const kept = await readJson<{ stream_key: string }>(keyPath(id));
    await navigator.clipboard.writeText(kept.stream_key);
    setCopied(id);
    window.setTimeout(() => setCopied(null), 4000);
  };

  React.useEffect(() => {
    let active = true;
    void (files.read('read_file', { name_or_identity: sourceFile }) as Promise<SourceFile>).then(file => {
      if (!active || file.encoding !== 'utf-8') return;
      const data = JSON.parse(file.content) as { sources?: NetworkSource[] };
      setSources((data.sources ?? []).filter(source => source.kind === 'hls' && Boolean(source.playback_url?.startsWith('https://'))));
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  React.useEffect(() => {
    if (!sources.length) return undefined;
    const look = async () => {
      const day = new Date().toISOString().slice(0, 10);
      const found = await Promise.all(sources.map(async source => {
        const folder = `${source.clips_folder}/${day}`;
        const listing = await readListing<ClipListing>(folder, { limit: 200 }).catch(() => ({ names: [] }));
        const latest = listing.names.filter(item => item.stored).sort((a, b) => b.name.localeCompare(a.name))[0] ?? null;
        return [source.id, latest] as const;
      }));
      setClips(Object.fromEntries(found));
    };
    void look();
    const timer = window.setInterval(() => { void look(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [sources]);

  if (!sources.length) return null;
  return <Container layout="grid" gridCols="auto-fill-xs" gap="md">
    {sources.map(source => <Card key={source.id} variant="nested" padding="none" overflow="hidden" data-always-input="network-camera">
      <LivePicture source={source} />
      <Container layout="vertical" gap="xs" padding="sm">
        <Text variant="body">{source.label}</Text>
        <Text variant="caption" color="muted">{source.connection ? `Over ${source.connection}. ` : ''}Each finished broadcast is filed in {source.clips_folder}.</Text>
        {source.ingest_url ? <Text variant="caption" color="muted">Camera address: {source.ingest_url}</Text> : null}
        <Button variant="outline" onClick={() => { return copyKey(source.id).catch(error => { setCopied(null); throw error; }); }}>{copied === source.id ? 'Key copied' : 'Copy camera key'}</Button>
        {clips[source.id] ? <Button variant="outline" onClick={() => { location.href = `/file/${encodeURIComponent(clips[source.id]!.identity)}`; }}>Open latest clip</Button> : null}
      </Container>
    </Card>)}
  </Container>;
}
