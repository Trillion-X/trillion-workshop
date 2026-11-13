// src/workspace/posts-screen.tsx
//
// PURPOSE
//   Posts (entry `posts`, the screen of tool:check-a-post, records/workshop-publishing-tool-records.json): every post
//   the person or their AI drafted, in the shared record views, in sections by where it stands (drafts, approved,
//   scheduled, partly posted, failed, posted). Opening one shows it beside the list: its words (paragraphs and line breaks as written,
//   each #tag, @handle and address marked, by the shared MarkdownWords), its video or picture,
//   its link and time, who it contacts first and where each was found (reaches; only the person approves such a post),
//   and each place it is going with that place's own words and settings, where its copy is, and
//   that place's ready check in plain words (src/post-ready.mjs over the place's row). Approve and Publish send the
//   same calls the AI's approve_post and publish_post send; a post that is not ready can be handed to the person's AI
//   to fix. The post's video, picture or sound is drawn by the one file preview (FilePreview) and plays in place, and
//   each row shows it as its picture (file-picture.ts, file-previews.json), with a Cards view, so what the AI made is
//   seen where it is approved, here and wherever this screen is shown (an AI chat's show_screen). A person writes a new draft here too (words and an optional time, new-post.tsx), and picks where a post
//   goes from their connected accounts; a draft may go nowhere yet, and while nothing is connected the screen says so
//   and offers Connect a place (Connections). The posts and an opened post are the person's post records, read through the
//   records door (records-door.ts) and shaped as the store shapes them (src/post-shape.mjs), so the screen and their AIs
//   always agree; presses go to the posts store (/work/api/posts, src/work-posts.mjs). Under an opened post is Notes and messages
//   (say-about-this.tsx) about that post: a note on its video is kept at the moment playing and reaches every AI with
//   the anchor { record: post_id, part: moment }, so "cut the first two seconds" is a revision the AI makes to this
//   draft (draft_post with its post_id); the person reviews again, then approves.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real posts: every row is one the store answered; no post yet says so and offers to write one or ask their
//      AI for one.
//   2. How a status or a place's state looks, which presses a post offers and which jobs go to the AI are DATA
//      (post-looks.json); nothing here names a status, a place or a setting.
//   3. The ready check shown is the store's own, never worked out here; where no owner answers it, none is shown.
//   4. Every element is a shared part (record views, Container, Text, Badge, Button, the queue-job button, the shared
//      loading, empty and failed states); this file writes no markup.

import { openFile } from './open-screen';
import * as React from 'react';
import { Badge, Button, Container, QueueJobButton, SchemaValueView, Text, Textarea, type BadgeProps } from '../../parts/ui';
import { RecordViews, type BulkAction, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { ScreenState, useScreenLoad, type EmptyScreenState } from '../../parts/ui/show/screen-state';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { notify } from '../../parts/ui/show/coss/notifications';
import { FilePreview } from '../../parts/ui/show/file-preview/FilePreview';
import { MarkdownWords } from '../../parts/ui/show/markdown-block/MarkdownWords';
import { bytesAddress, contentTypeOf, filePicture } from './file-picture';
import { postJson } from './api';
import { listRecords, readRecord } from './records-door';
import { shapePost } from '../post-shape.mjs';
import postSettings from '../social-posts.json';
import { refusal } from './failure';
import { recordFilter } from './record-filter';
import { queueJobProps, queuedJobLabel, sendQueuedJob } from './queue-job';
import { ConnectNotice, NewPost, PostPlacesEditor, readPostPlaces, type PostFile, type PostPlaces } from './new-post';
import { SayAboutThis, isRecording, usePlayClock } from './say-about-this';
import looks from './post-looks.json';
import type { ScreenProps } from './lazy-screen';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Delivery = { account_id: string; platform?: string | null; label?: string | null; status: string; url?: string; error?: string };
type Post = {
  post_id: string; status: string; caption: string; link: string | null; scheduled_for: string | null; sent_at?: string | null;
  media: { identity: string; name?: string; media_type?: string } | null;
  source?: { kind: string; label: string; id: string; title: string } | null; format_id?: string | null;
  caption_by_platform: Record<string, string>; settings_by_platform: Record<string, Record<string, unknown>>;
  reaches?: Reached[]; grounded?: Grounded; destinations: Delivery[]; created_at: string; updated_at: string;
};
type Reached = { network: string | null; handle: string; profile_url: string; provenance: { source: string; url: string; title: string | null; posted_at: string | null }[] };
type Grounded = { checked: boolean; grounded?: boolean };
type Finding = { check: string; said: string };
type PlaceCheck = { account_id: string; platform: string | null; label: string | null; name: string | null; ready: boolean; problems: Finding[]; not_checked: Finding[]; said: string };
type Check = { ready: boolean; said: string; destinations: PlaceCheck[] };
type Row = { id: string; words: string; status: string; places: string; file: string; when: string; at: number; order: number; media: Post['media'] };

const API = '/work/api/posts';
// A post is the person's record of this type (src/social-posts.json record_type); its id is its post_id.
const POST = postSettings.record_type;
const postRecordId = (postId: string) => (postId.startsWith(`${POST}:`) ? postId : `${POST}:${postId}`);
const tone = (value: string | undefined) => (value ?? 'neutral') as BadgeProps['variant'];
const statusOf = (id: string) => looks.statuses.find(item => item.id === id);
const order = (id: string) => { const at = looks.statuses.findIndex(item => item.id === id); return at < 0 ? looks.statuses.length : at; };
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const placeName = (item: { label?: string | null; platform?: string | null; account_id: string }) => item.label ?? item.platform ?? item.account_id;
const openPostFile = (media: NonNullable<Post['media']>) => openFile({ id: media.identity, name: media.name });

const FIELDS: FieldDescriptor[] = [
  // The post's video, picture or sound as its picture; which picture a kind shows is DATA (file-previews.json).
  { id: 'picture', label: 'Picture', icon: 'Image', kind: 'thumbnail', width: 72, read: () => '',
    render: (row: Row) => filePicture({ name: row.media?.name ?? '', mediaType: row.media?.media_type, identity: row.media?.identity, bytes: row.media ? bytesAddress(row.media.identity) : null, title: row.words }) },
  { id: 'words', label: 'Words', icon: 'Text', preview: 'heading', ruleKind: 'text', filterable: true, sortable: true, width: 380 },
  { id: 'status', label: 'Status', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 150, sortValue: (row: Row) => row.order,
    values: Object.fromEntries(looks.statuses.map(item => [item.id, { label: item.label, tone: item.tone }])) },
  { id: 'places', label: 'Going to', icon: 'Send', ruleKind: 'text', filterable: true, width: 220 },
  { id: 'file', label: 'Video or picture', icon: 'Film', ruleKind: 'text', filterable: true, width: 200 },
  { id: 'when', label: 'When', icon: 'CalendarClock', ruleKind: 'date', sortable: true, width: 160, factValue: (row: Row) => row.at, sortValue: (row: Row) => row.at },
];

// Where a post goes, by each account's own name (its connected place), never by its id.
const rowOf = (post: Post, accounts: Map<string, { label?: string | null; platform?: string | null; account_id: string }>): Row => {
  const time = post.scheduled_for ?? post.sent_at ?? post.updated_at;
  return {
    id: post.post_id, words: post.caption || 'No words', status: post.status, places: post.destinations.map(item => placeName(accounts.get(item.account_id) ?? item)).join(', '),
    file: post.media?.name?.split('/').pop() ?? '', when: when(time), at: Date.parse(time), order: order(post.status), media: post.media,
  };
};

/** One press on a post (Approve, Publish), answered in the store's own words. */
async function press(action: (typeof looks.actions)[number], postId: string): Promise<void> {
  try {
    const answer = await postJson<{ said?: string }>(`${API}/${action.id}`, { post_id: postId });
    notify(answer.said || action.done, { kind: 'done' });
  } catch (error) {
    notify(errorWords(error), { kind: 'error' });
  }
}

const askForFirstPost = async () => {
  try {
    const answer = await sendQueuedJob({ job_id: looks.ask_ai.draft.job_id, context: looks.ask_ai.draft.context, press_key: crypto.randomUUID() });
    notify(answer.said, { kind: 'done' });
  } catch (error) {
    notify(errorWords(error), { kind: 'error' });
  }
};

const noPosts = (write: () => void): EmptyScreenState => ({
  status: 'empty', icon: 'Send', title: looks.empty.title, description: looks.empty.description,
  action: { label: looks.write.open, run: write },
  secondary: { label: queuedJobLabel(looks.ask_ai.draft.job_id) ?? looks.write.open, run: () => void askForFirstPost() },
});

/** One place a post is going: its words and settings there, where its copy is, and its ready check. */
function Place({ post, delivery, check }: { post: Post; delivery: Delivery | undefined; check: PlaceCheck | undefined }) {
  const platform = check?.platform ?? delivery?.platform ?? null;
  const words = platform ? post.caption_by_platform[platform] : undefined;
  const chosen = Object.entries((platform && post.settings_by_platform[platform]) || {});
  const state = delivery?.status ?? 'not sent';
  return (
    <Container layout="vertical" gap="sm" padding="md" border="all" rounded="lg" data-post-place={platform ?? ''}>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Container layout="vertical" gap="none" minWidth="0">
          <Text variant="body" truncate>{placeName(check ?? delivery ?? { account_id: '' })}</Text>
          {check?.name ? <Text variant="caption" truncate>{check.name}</Text> : null}
        </Container>
        <Container layout="horizontal" gap="xs" alignItems="center">
          <Badge size="sm" variant={tone((looks.destination_states as Record<string, string>)[state])}>{state}</Badge>
          {check ? <Badge size="sm" variant={check.ready ? 'success' : 'warning'}>{check.ready ? 'Ready' : 'Not ready'}</Badge> : null}
        </Container>
      </Container>
      <Text variant="caption">{words ? `Its own words: ${words}` : 'The post\'s words'}</Text>
      {chosen.map(([name, value]) => typeof value === 'string'
        ? <Text key={name} variant="caption">{`${name}: ${value}`}</Text>
        : <Container key={name} layout="vertical" gap="none"><Text variant="caption">{name}</Text><SchemaValueView value={value} /></Container>)}
      {check?.problems.map(item => <Text key={`${item.check}:${item.said}`} variant="body-xs">{item.said}</Text>)}
      {check?.not_checked.map(item => <Text key={`${item.check}:${item.said}`} variant="caption">{item.said}</Text>)}
      {delivery?.error ? <Text variant="body-xs">{delivery.error}</Text> : null}
      {delivery?.url ? <Button size="sm" variant="ghost" onClick={() => window.open(delivery.url, '_blank', 'noopener')}>{`Open on ${placeName(delivery)}`}</Button> : null}
    </Container>
  );
}

/** Who a post contacts first, each with where they were found, read before the person approves it. */
function ReachedPeople({ people, grounded }: { people: Reached[]; grounded?: Grounded }) {
  const open = (url: string) => window.open(url, '_blank', 'noopener');
  return (
    <Container layout="vertical" gap="sm" padding="md" border="all" rounded="lg" data-post-reaches="">
      <Text variant="body">{looks.reaches.heading}</Text>
      <Text variant="caption">{looks.reaches.only_you}</Text>
      {grounded?.checked && grounded.grounded === false ? <Text variant="body-xs">{looks.reaches.not_grounded}</Text> : null}
      {people.map(person => (
        <Container key={person.handle} layout="vertical" gap="xs">
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
            <Text variant="body" truncate>{`@${person.handle}`}</Text>
            <Button size="sm" variant="ghost" onClick={() => open(person.profile_url)}>{looks.reaches.open_profile}</Button>
          </Container>
          {person.provenance.map(found => (
            <Container key={found.url} layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
              <Text variant="caption" truncate>{looks.reaches.found.replace('{source}', found.source).replace('{title}', found.title ?? found.url)}</Text>
              <Button size="sm" variant="ghost" onClick={() => open(found.url)}>{looks.reaches.open_found}</Button>
            </Container>
          ))}
        </Container>
      ))}
    </Container>
  );
}

/** The person changing a draft's words: saved through the same draft the AI's draft_post makes, so the change is kept as
 *  their edit of what was there (their voice is learned from it, Workshop tool:keep-a-voice-edit) and the post is a draft again. */
function EditWords({ post, saved }: { post: Post; saved: () => void }) {
  const [editing, setEditing] = React.useState(false);
  const [words, setWords] = React.useState(post.caption);
  const [busy, setBusy] = React.useState(false);
  if (!editing) return <Button size="sm" variant="ghost" data-post-edit="" onClick={() => { setWords(post.caption); setEditing(true); }}>{looks.edit.open}</Button>;
  const save = async () => {
    setBusy(true);
    try {
      await postJson(`${API}/draft`, { post_id: post.post_id, caption: words });
      notify(looks.edit.saved, { kind: 'done' });
      setEditing(false);
      saved();
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    } finally { setBusy(false); }
  };
  return (
    <Container layout="vertical" gap="sm" data-post-editor="">
      <Textarea label={looks.edit.label} rows={5} autoGrow value={words} onChange={event => setWords(event.target.value)} />
      <Container layout="horizontal" gap="xs" alignItems="center">
        <Button size="sm" variant="primary" loading={busy} disabled={busy || !words.trim() || words === post.caption} onClick={() => save()}>{busy ? looks.edit.saving : looks.edit.save}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>{looks.edit.cancel}</Button>
      </Container>
    </Container>
  );
}

/** The opened post beside the list: read again from the store with its ready check each time it is opened. */
function OpenPost({ postId, places, changed, close }: { postId: string; places: PostPlaces | null; changed: () => void; close?: () => void }) {
  const loaded = useScreenLoad(`post:${postId}`, {
    loading: { label: 'Loading the post', layout: 'preview' },
    read: async () => {
      // The post is read through the records door. The ready check was the posts store's own; no owner answers it on
      // this engine, so none is shown rather than one worked out here (invariant 3).
      const kept = await readRecord(postRecordId(postId), POST);
      if (!kept) throw Object.assign(new Error('This post is not kept any more.'), { status: 404 });
      return { post: shapePost(kept) as Post, check: null as Check | null };
    },
    failed: refusal('This post could not load'),
  });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <OpenedPost post={loaded.value.post} check={loaded.value.check} places={places} changed={changed} close={close} reload={() => void loaded.reload()} />;
}

/** One loaded post: its words, its media playing beside Notes and messages (a note is kept at the moment playing and
 *  goes to the person's AIs about this post, which revise the draft), its presses and its places. */
function OpenedPost({ post, check, places, changed, close, reload }: { post: Post; check: Check | null; places: PostPlaces | null; changed: () => void; close?: () => void; reload: () => void }) {
  const playing = usePlayClock();
  const recording = Boolean(post.media && isRecording(contentTypeOf(post.media.name ?? '', post.media.media_type)));
  const status = statusOf(post.status);
  const byAccount = new Map((check?.destinations ?? []).map(item => [item.account_id, item]));
  const fix = !check || check.ready ? null : queueJobProps(looks.ask_ai.fix.job_id, { post_id: post.post_id });
  const inMyVoice = ['draft', 'approved'].includes(post.status) ? queueJobProps(looks.ask_ai.voice.job_id, { post_id: post.post_id }) : null;
  const learn = queueJobProps(looks.ask_ai.learn.job_id, looks.ask_ai.learn.context);
  const reworks = ['draft', 'approved'].includes(post.status)
    ? looks.ask_ai.rework.ways.flatMap(way => { const props = queueJobProps(looks.ask_ai.rework.job_id, { post_id: post.post_id, how: way.how }); return props ? [{ id: way.id, props: { ...props, label: way.label } }] : []; })
    : [];
  const run = async (action: (typeof looks.actions)[number]) => { await press(action, post.post_id); changed(); reload(); };
  return (
    <Container layout="vertical" gap="md" padding="lg" data-post={post.post_id}>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Badge variant={tone(status?.tone)}>{status?.label ?? post.status}</Badge>
        <Container layout="horizontal" gap="xs" alignItems="center">
          {looks.actions.filter(action => action.when.includes(post.status)).map(action => (
            <Button key={action.id} size="sm" variant="primary" data-post-action={action.id} onClick={() => run(action)}>{action.label}</Button>
          ))}
          {close ? <Button size="sm" variant="ghost" onClick={close}>Close</Button> : null}
        </Container>
      </Container>
      {post.caption ? <MarkdownWords words={post.caption} breaks /> : <Text variant="body">No words</Text>}
      {['draft', 'approved'].includes(post.status) ? <EditWords key={post.caption} post={post} saved={() => { changed(); reload(); }} /> : null}
      <Container layout="horizontal" gap="xs" wrap alignItems="center">
        {inMyVoice ? <QueueJobButton {...inMyVoice} /> : null}
        {reworks.map(item => <QueueJobButton key={item.id} {...item.props} />)}
        {learn ? <QueueJobButton {...learn} /> : null}
      </Container>
      {post.source ? <Text variant="caption" truncate>{`From ${post.source.title || post.source.label} · ${post.source.label}`}</Text> : null}
      {post.reaches?.length ? <ReachedPeople people={post.reaches} grounded={post.grounded} /> : null}
      {post.media ? (
        <Container layout="vertical" heightPx={looks.media_height} minHeight="0" data-post-media="">
          <FilePreview url={bytesAddress(post.media.identity)} contentType={contentTypeOf(post.media.name ?? '', post.media.media_type)} label={post.media.name?.split('/').pop() ?? ''} autoPlay={false}
            onTimeChange={recording ? playing.heard : undefined} seekRequest={recording ? playing.seekRequest : undefined} />
        </Container>
      ) : null}
      {post.media ? (
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="caption" truncate>{post.media.name?.split('/').pop() ?? ''}</Text>
          <Button size="sm" variant="ghost" onClick={() => openPostFile(post.media!)}>Open</Button>
        </Container>
      ) : <Text variant="caption">No video or picture</Text>}
      {post.link ? <Text variant="caption" truncate>{`Link: ${post.link}`}</Text> : null}
      {post.scheduled_for ? <Text variant="caption">{`Goes out ${when(post.scheduled_for)}`}</Text> : null}
      {check ? (
        <Container layout="horizontal" gap="sm" wrap alignItems="center" justifyContent="between">
          <Text variant="body-xs">{check.said}</Text>
          {fix ? <QueueJobButton {...fix} /> : null}
        </Container>
      ) : null}
      {post.status === 'draft' ? <PostPlacesEditor key={post.destinations.map(item => item.account_id).join()} postId={post.post_id} places={places} current={post.destinations.map(item => item.account_id)} onSaved={() => { changed(); reload(); }} /> : null}
      {post.destinations.map(delivery => <Place key={delivery.account_id} post={post} delivery={delivery} check={byAccount.get(delivery.account_id)} />)}
      <SayAboutThis record={post.post_id} files={post.media ? [{ identity: post.media.identity }] : []} title={post.caption.split('\n')[0]?.slice(0, 80) || post.post_id}
        clock={recording ? playing.clock : null} onSeek={recording ? playing.seek : undefined} />
    </Container>
  );
}

function Posts({ posts, places, writing, setWriting, reload, first, media }: { posts: Post[]; places: PostPlaces | null; writing: boolean; setWriting: (on: boolean) => void; reload: () => void; first: string | null; media: PostFile | null }) {
  // Opened at one post (a notice's Open, /use/check-a-post/<post>): that post shows beside the list at once.
  const [open, setOpen] = React.useState<string | null>(first && posts.some(post => post.post_id === first) ? first : null);
  const opened = (id: string | null) => { setWriting(false); setOpen(id); };
  const rows = React.useMemo(() => {
    const accounts = new Map((places?.destinations ?? []).map(account => [account.account_id, account] as const));
    return posts.map(post => rowOf(post, accounts)).sort((a, b) => a.order - b.order || b.at - a.at);
  }, [posts, places]);
  const actions = React.useMemo<BulkAction[]>(() => looks.actions.map(action => ({
    id: action.id, label: action.label, icon: action.icon,
    appliesTo: (row: Row) => action.when.includes(row.status),
    run: ids => { void Promise.all(ids.map(id => press(action, id))).finally(reload); },
  })), [reload]);
  return (
    <Container layout="horizontal" gap="none" height="full" minHeight="0" data-posts-screen="" data-opened-beside-list="">
      <Container layout="vertical" flex={1} minHeight="0" minWidth="0" data-opened-list="">
        <ConnectNotice places={places} />
        <RecordViews
          label="Posts"
          {...recordFilter}
          fields={FIELDS}
          records={rows}
          identify={(row: Row) => row.id}
          aboutRecord={(row: Row) => ({ kind: 'record', id: row.id, record: row.id, title: row.words })}
          views={[{ id: 'table', label: 'Table', icon: 'Table' }, { id: 'gallery', label: 'Cards', icon: 'LayoutGrid' }]}
          view="table"
          groupDividerBy="status"
          onOpen={opened}
          rowActions={actions}
          preferenceKey="trillion-posts"
          emptyMessage="No post matches."
          primaryAction={{ label: looks.write.open, icon: 'SquarePen', onSelect: () => { setOpen(null); setWriting(true); } }}
        />
      </Container>
      {writing || open ? (
        <Container layout="vertical" width="420px" minHeight="0" overflow="auto" border="all" background="secondary" data-opened-item="">
          {writing
            ? <NewPost places={places} media={media} onClose={() => setWriting(false)} onKept={id => { reload(); opened(id); }} />
            : <OpenPost key={open!} postId={open!} places={places} changed={reload} close={() => setOpen(null)} />}
        </Container>
      ) : null}
    </Container>
  );
}

function PostsRoot({ first, media }: { first: string | null; media: PostFile | null }) {
  // Opened with a file (a recording's card: Post or schedule), Posts opens on a new post with that file.
  const [writing, setWriting] = React.useState(Boolean(media));
  const [places, setPlaces] = React.useState<PostPlaces | null>(null);
  React.useEffect(() => { readPostPlaces().then(setPlaces, () => setPlaces(null)); }, []);
  const loaded = useScreenLoad('posts', {
    loading: { label: 'Loading your posts', layout: 'rows' },
    read: () => listRecords({ type: POST }).then(records => records.map(record => shapePost(record.value) as Post)),
    failed: refusal('Your posts could not load'),
  });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  // No post yet: said plainly, with Write a post and Ask my AI, and Connect a place while nothing is connected.
  if (!loaded.value.length && !writing) {
    return (
      <Container layout="vertical" gap="sm" height="full" minHeight="0" padding="sm" data-posts-screen="">
        <ConnectNotice places={places} />
        <ScreenState state={noPosts(() => setWriting(true))} />
      </Container>
    );
  }
  return <Posts posts={loaded.value} places={places} writing={writing} setWriting={setWriting} reload={() => void loaded.reload()} first={first} media={media} />;
}

// The file a Posts tab was opened with, when its input names a stored one.
function mediaOf(input: unknown): PostFile | null {
  const media = input as { identity?: unknown; name?: unknown; media_type?: unknown } | null | undefined;
  if (!media || typeof media.identity !== 'string' || !media.identity) return null;
  return { identity: media.identity, ...(typeof media.name === 'string' && media.name ? { name: media.name } : {}), ...(typeof media.media_type === 'string' && media.media_type ? { media_type: media.media_type } : {}) };
}

/** The same owner, narrowed to one item: media, destinations, critique and actions, with no unrelated list. */
function PostInPlace({ postId, changed }: { postId: string; changed?: () => void }) {
  const [places, setPlaces] = React.useState<PostPlaces | null>(null);
  React.useEffect(() => { let live = true; readPostPlaces().then(value => { if (live) setPlaces(value); }, () => {}); return () => { live = false; }; }, []);
  return <OpenPost postId={postId} places={places} changed={() => changed?.()} />;
}

export function mountPostsScreen(element: HTMLElement, props: ScreenProps = {}): () => void {
  const item = props.surfaceInput?.post_id ?? props.surfaceInput?.item;
  if (props.inPlace && typeof item === 'string' && item) return mountReactSurface(element, <PostInPlace postId={item} changed={props.onChanged} />);
  return mountReactSurface(element, <PostsRoot first={typeof item === 'string' && item ? item : null} media={mediaOf(props.surfaceInput?.media)} />);
}
