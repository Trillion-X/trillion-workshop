// src/workspace/controls-previews.tsx
//
// PURPOSE
//   What an interface of live controls (controls-screen.tsx) shows beside its controls, looked up by the tool's own
//   `controls.preview.kind` (src/made-controls.mjs). Each preview is drawn from the values as they are right now, with
//   no run and no AI: a video's look through the browser twin of its render filters, a reply in its thread before it is
//   sent, a screen opened with the values. A kind with no preview here shows the values themselves.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The screen never names a kind: it hands `preview` and the values to `PREVIEWS[preview.kind]`. Adding a kind is a
//      row here plus DATA on a tool, never a change to the screen.
//   2. A preview reads only what its DATA names (`preview.input`, `preview.space`, ...): which value is the video, the
//      space, the words.
//   3. A preview shows the person's saved copy beside the live one when there is one, so they can see the two agree.
//   4. A change the live preview cannot show is said, never pretended (preview-grade.mjs `unpreviewed`).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Card, Container, SegmentedControl, Text } from '../../parts/ui';
import { MediaFrame } from '../../parts/ui/show/media-frame/MediaFrame';
import { PixelPreview } from '../../parts/ui/show/pixel-preview';
import { Thread, type ThreadPost } from '../../parts/ui/show/coss/thread';
import { ScreenState } from '../../parts/ui/show/screen-state';
import { frameGrader, previewedAdjustments, unpreviewed } from '../../parts/media-composition/read-data/preview-grade.mjs';
import { LOOKS } from '../../parts/media-composition/read-data/looks.mjs';
import { readJson } from './api';
import { bytesAddress } from './file-picture';
import { relativeWhen } from '../../parts/ui/show/relative-time/relative-time';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { screens } from './screen-mounts';
import type { Unmount } from './lazy-screen';

export type Kept = { identity?: string; media_type?: string | null; name?: string; item_id?: string; at?: string; task_id?: string; request_key?: string; values?: Record<string, unknown> };
export type PreviewProps = {
  preview: Record<string, unknown>;
  values: Record<string, unknown>;
  bind: Record<string, unknown>;
  kept: readonly Kept[];
  title: string;
  labels?: Readonly<Record<string, string>>;
  controlValues?: Record<string, unknown>;
  onValueChange?: (key: string, value: unknown) => void;
  hiddenInputs?: readonly string[];
};

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const fieldOf = (preview: Record<string, unknown>, name: string) => text(preview[name]);

// A video's look, painted live from its colour choices.
function VideoLook({ preview, values, bind, kept, title }: PreviewProps) {
  const identity = text(bind[fieldOf(preview, 'input') || 'video']);
  const mediaType = text(preview.media_type) || 'video/mp4';
  const previewed = React.useMemo(() => new Set(previewedAdjustments()), []);
  const known = React.useMemo(() => new Set(LOOKS.adjustments.map((row: { id: string }) => row.id)), []);
  const adjust = React.useMemo(() => Object.fromEntries(Object.entries(values).filter(([key, value]) => known.has(key) && typeof value === 'number' && Number.isFinite(value))), [values, known]);
  const paint = React.useMemo(() => {
    const shown = Object.fromEntries(Object.entries(adjust).filter(([key]) => previewed.has(key)));
    try { return frameGrader(shown); } catch { return null; }
  }, [adjust, previewed]);
  const notShown = React.useMemo(() => { try { return unpreviewed(adjust); } catch { return []; } }, [adjust]);
  const saved = kept.find(one => one.identity);
  const [view, setView] = React.useState<'live' | 'original' | 'saved'>('live');
  React.useEffect(() => { if (view === 'saved' && !saved) setView('live'); }, [saved, view]);
  if (!identity) return <ScreenState state={{ status: 'empty', icon: 'Video', title: 'No video chosen yet', description: 'Ask your AI which video this works on.' }} />;
  const views = [{ id: 'live', label: 'Live' }, { id: 'original', label: 'Original' }, ...(saved ? [{ id: 'saved', label: 'Full copy' }] : [])];
  return (
    <Container layout="vertical" gap="sm" minWidth="0" data-controls-preview="video-look" data-preview-view={view}>
      {view === 'saved' && saved?.identity
        ? <MediaFrame url={bytesAddress(saved.identity)} mediaType={saved.media_type || mediaType} label={`${title}, the full copy`} muted loop playsInline autoPlay />
        : <PixelPreview source={bytesAddress(identity)} mediaType={mediaType} label={view === 'live' ? `${title}, as it will look` : `${title}, as it is now`} paint={view === 'live' ? paint : null} />}
      <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap">
        <SegmentedControl ariaLabel="Which to show" items={views} value={view} onValueChange={id => setView(id as typeof view)} />
        {notShown.length ? <Text variant="caption" color="muted">Some changes show only in the full copy.</Text> : null}
      </Container>
    </Container>
  );
}

type SpaceItem = { item_id: string; kind: string; title?: string | null; body?: { text?: string } | null; reply_to?: string | null; provenance?: { by?: string; by_you?: boolean; added_at?: string } };

// A reply drawn in its conversation, under what it answers, before it is sent.
function ThreadReply({ preview, values, bind, kept }: PreviewProps) {
  const spaceId = text(bind[fieldOf(preview, 'space') || 'space_id']);
  const replyTo = text(bind[fieldOf(preview, 'reply_to') || 'reply_to']);
  const words = text(values[fieldOf(preview, 'words') || 'text']);
  const [items, setItems] = React.useState<SpaceItem[] | null>(null);
  const [failed, setFailed] = React.useState('');
  const sent = kept[0]?.at ?? kept[0]?.item_id ?? kept[0]?.identity ?? '';
  React.useEffect(() => {
    if (!spaceId) return;
    let gone = false;
    setItems(null);
    setFailed('');
    const path = `/work/api/spaces/${encodeURIComponent(spaceId)}/items`;
    Promise.all([
      readJson<{ items?: SpaceItem[] }>(`${path}?limit=40`),
      replyTo ? readJson<{ items?: SpaceItem[] }>(`${path}?item_id=${encodeURIComponent(replyTo)}&limit=1`) : Promise.resolve({ items: [] }),
    ])
      .then(([recent, target]) => {
        if (gone) return;
        const exact = target.items?.find(item => item.item_id === replyTo);
        if (replyTo && !exact) { setFailed('The message you are replying to is unavailable.'); return; }
        setItems(exact ? [exact, ...(recent.items ?? []).filter(item => item.item_id !== exact.item_id)] : recent.items ?? []);
      })
      .catch(error => { if (!gone) setFailed(errorWords(error, 'The conversation could not load.')); });
    return () => { gone = true; };
  }, [spaceId, replyTo, sent]);
  if (!spaceId) return <ScreenState state={{ status: 'empty', icon: 'MessageSquare', title: 'No conversation chosen yet', description: 'Ask your AI which conversation this reply is for.' }} />;
  if (failed) return <Text variant="body-sm" color="error" role="alert">{failed}</Text>;
  if (!items) return <ScreenState state={{ status: 'loading', label: 'Loading the conversation', layout: 'rows' }} />;
  const post = (item: SpaceItem): ThreadPost => ({
    id: item.item_id, author: item.provenance?.by ?? 'Someone', you: item.provenance?.by_you, when: item.provenance?.added_at ? relativeWhen(item.provenance.added_at) : undefined,
    body: item.body?.text ?? item.title ?? '',
  });
  const answered = items.find(item => item.item_id === replyTo);
  const replies = items.filter(item => replyTo && item.reply_to === replyTo).reverse().map(post);
  const draft: ThreadPost[] = words.trim() ? [{ id: 'draft', author: 'You', you: true, body: words, tag: 'Not sent yet' }] : [];
  const posts: ThreadPost[] = answered ? [{ ...post(answered), replies: [...replies, ...draft] }] : [...draft, ...items.filter(item => item.kind === 'message').slice(0, 8).map(post)];
  return (
    <Container layout="vertical" gap="sm" minWidth="0" data-controls-preview="thread">
      <Thread thread={{ posts, empty: 'Nothing here yet.', words: { collapse: 'Hide replies', expand: 'Show replies', cancel: 'Cancel' } }} onAction={() => undefined} />
    </Container>
  );
}

// A screen of Trillion's own, updated in place with the bound subject and settled values.
function ScreenWith({ preview, values, bind }: PreviewProps) {
  const host = React.useRef<HTMLElement>(null);
  const mounted = React.useRef<{ entry: string; unmount: Unmount } | null>(null);
  const entry = fieldOf(preview, 'entry');
  const [settled, setSettled] = React.useState(values);
  const surfaceInput = React.useMemo(() => Object.fromEntries(
    Object.entries({ ...bind, ...settled, ...(preview.input && typeof preview.input === 'object' ? preview.input as Record<string, unknown> : {}) }).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ), [bind, settled, preview.input]);
  React.useEffect(() => { const wait = setTimeout(() => setSettled(values), 450); return () => clearTimeout(wait); }, [values]);
  React.useEffect(() => {
    const mount = screens[entry];
    const element = host.current;
    if (!mount || !element) return undefined;
    const unmount = mount(element, { surfaceInput });
    mounted.current = { entry, unmount };
    return () => {
      if (mounted.current?.unmount === unmount) mounted.current = null;
      unmount();
    };
  }, [entry]);
  React.useEffect(() => {
    if (mounted.current?.entry === entry) mounted.current.unmount.update?.({ surfaceInput });
  }, [entry, surfaceInput]);
  if (!screens[entry]) return <ValuesOnly preview={preview} values={values} bind={{}} kept={[]} title="" />;
  return <Card ref={host} variant="outline" padding="none" layout="column" minHeight="0" style={{ minWidth: '0' }} className="h-[min(70vh,44rem)] overflow-hidden gap-3" data-controls-preview="screen" />;
}

// One selected record from caller-bound DATA. The screen supplies field names;
// private rows stay in bind and only the selected row reaches the shared detail renderer.
// No preview of its own: the values, so the person still sees what will be used.
function ValuesOnly({ values, labels = {} }: PreviewProps) {
  const shown = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return (
    <Container layout="vertical" gap="xs" data-controls-preview="values">
      {shown.length ? shown.map(([key, value]) => <Text key={key} variant="body-sm">{`${labels[key] ?? key.replace(/[_-]+/g, ' ')}: ${Array.isArray(value) ? value.join(', ') : String(value)}`}</Text>) : <Text variant="body-sm" color="muted">Nothing set yet.</Text>}
    </Container>
  );
}

/** The previews by kind (invariant 1). */
export const PREVIEWS: Record<string, React.ComponentType<PreviewProps>> = {
  'video-look': VideoLook,
  thread: ThreadReply,
  screen: ScreenWith,
  values: ValuesOnly,
};

/** A composed view must resolve to a real preview or registered Trillion screen. */
export function supportsControlsPreview(preview: Record<string, unknown>) {
  const kind = text(preview.kind);
  if (kind === 'screen') return Boolean(screens[fieldOf(preview, 'entry')]);
  return Boolean(kind && Object.hasOwn(PREVIEWS, kind));
}

export function ControlsPreview(props: PreviewProps) {
  const Shown = PREVIEWS[text(props.preview.kind)] ?? ValuesOnly;
  return <Shown {...props} />;
}
