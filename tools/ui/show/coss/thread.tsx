// parts/ui/show/coss/thread.tsx
//
// PURPOSE
//   A discussion drawn from DATA: a box to start one, then posts, each with who wrote it and when, its words, a vote
//   pill, a reply box that opens under it, and its replies nested beneath it on a thin rail (folded away and back).
//   Adapted from 21st.dev's "Reddit nested thread reply" (reddit-nested-thread-reply.tsx, gathered by the team in
//   community-components.md): the avatar beside the author line, the rounded vote pill, the ghost Reply action, the
//   left rail per depth and the Expand (n) / Collapse toggle. Dropped from it: made-up avatars from a third-party
//   image service, Award/Share/More buttons with nothing behind them, down votes, and local-only state that invents
//   posts; here every post and count is the caller's, and every press is reported to the caller.
//   With `style: 'cards'` each top-level post is its own card, as a feed draws it (after the Promethee activity feed
//   from the community reference captures): avatar, author and when it was written on top, the words, then a foot
//   row with the vote pill, the reactions, the replies count that unfolds them and Reply (Reply and the way to add a
//   reaction show while the card is pointed at or focused). Its replies
//   start folded and unfold inside the card as the same nested discussion.
//   A post the reader may react to carries its reactions and the picker (../reactions/ReactionRow); a reply about some
//   of its parent's words shows those words above its own; resting on a face or name opens who they are, the posts they
//   wrote here, and each post in place with its reactions and a reply box (./person-hover).
//   A post can carry a thing someone shared into the conversation (`attachment`: its kind mark, title, a line or two
//   of its words, a picture, Open; after 21st.dev 30730 "message attachment" and 29545 "attachment card", and Tana's
//   chat with attached things), a `…` menu of the caller's rows (21st.dev 28340 activity timeline row menu), or be
//   `withdrawn` (one quiet line in place of its words). A conversation reads `newest-last` (newest at the bottom, the
//   box under it, older posts above behind "Show older", as Slack and Telegram draw a channel) or `newest-first`
//   (a feed). Posts are drawn through the shared virtual-list, so a conversation of 10^5 posts puts only what is on
//   screen into the page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no product words and no addresses: labels come with the DATA, and an action is reported to the
//      caller (`onAction`) with the typed words under `text`. A menu row is reported as `{ id, label }` and an
//      attachment's Open as its own action, both with the post's id under `post`.
//   2. Nothing is shown that the caller did not send: no invented avatars, scores or times.
//   3. `posts` are always listed newest first (the order a page of a conversation is read in); `order` only decides
//      which end is drawn at the top. Reading an older page appends to the end of `posts`.
//   4. Controls are the licensed Coss sources (Button, Badge, Avatar, Textarea) and the shared ActionMenu, kind mark
//      and media preview; appearance lives in screen-look/show/guide.css (`.thread-*`).
//   5. A post's `mentions` are drawn where their `@label` is written, each as the shared live record chip
//      (../record-chip), whose looks and addresses the caller hands down with RecordChipProvider.

import * as React from 'react';
import { ChevronUp, MessageSquare, Reply as ReplyIcon } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { DisplayMark } from '../display-mark';
import { Textarea } from './ui/textarea';
import { ActionMenu } from '../action-menu/ActionMenu';
import { MediaPreview, type MediaPreviewProps } from '../media-preview/MediaPreview';
import { RecordKindMark } from '../record-kind/RecordKindMark';
import { MentionWords } from '../record-chip/RecordChip';
import type { KeptMention } from '../record-chip/mention-runs';
import { VirtualList } from '../virtual-list/VirtualList';
import { ReactionRow, type OfferedReaction, type Reaction } from '../reactions/ReactionRow';
import { PersonHover } from './person-hover';

/** What a press does: `send` is the caller's own description of the request; `id` names a menu row that was chosen. */
export type ThreadAction = { label: string; id?: string; send?: { path: string; body?: Record<string, unknown>; with_fields?: boolean } };
/** A thing shared into the conversation, shown inside the post of whoever shared it. `kind` is the thing's own kind
 *  (drawn by the shared kind mark, so a kind nobody named still reads), `detail` a line or two of its words. */
export type ThreadAttachment = { kind: string; title: string; detail?: string; preview?: MediaPreviewProps; open?: ThreadAction };
/** One row of a post's `…` menu. `confirm`, when set, turns the row into that question on the first choice and runs
 *  it on the second; `tone: 'destructive'` tints it. */
export type ThreadMenuItem = { id: string; label: string; icon: string; tone?: string; confirm?: string };
/** One post: `vote` is offered when the reader may vote (its label says what pressing does), `voted` marks a vote
 *  already given, `reply` opens a box whose words are sent under `text`. `withdrawn` replaces the words (and every
 *  action on them) with one quiet line. `mentions` are the things the words name, each drawn at its `@label`. */
export type ThreadPost = {
  id: string; author: string; you?: boolean; when?: string; body: string; mentions?: readonly KeptMention[]; tag?: string;
  score?: number; voted?: boolean; vote?: ThreadAction; reply?: ThreadAction; reply_placeholder?: string;
  attachment?: ThreadAttachment; menu?: ThreadMenuItem[]; withdrawn?: string;
  /** The reactions given to it; `react`, when the reader may react, is reported with { symbol?, glyph?, on };
   *  `palette` the reactions offered on it (else the thread's). */
  reactions?: Reaction[]; react?: ThreadAction; palette?: OfferedReaction[];
  /** The piece of what it answers that these words are about, shown above them (some of that post's words). */
  part?: { quote: string };
  /** What the author sent it through (an AI app), drawn after their name with its mark: `picture` a logo's address,
   *  else the name's first letters. */
  via?: { name: string; picture?: string };
  replies?: ThreadPost[];
};
/** `theirs` says how many posts a person has here, `{count}` standing for the number ("{count} posts here"). */
export type ThreadWords = { collapse: string; expand: string; cancel: string; menu?: string; theirs?: string };
export type ThreadDescription = {
  compose?: { placeholder: string; action: ThreadAction };
  /** Newest first; see `order`. */
  posts: ThreadPost[];
  empty?: string;
  words?: ThreadWords;
  /** 'cards' draws each post as its own card, as a feed does; the default is one continuous discussion. */
  style?: 'discussion' | 'cards';
  /** 'newest-last' draws the newest post at the bottom with the box under it and keeps the newest in view as posts
   *  arrive; the default 'newest-first' draws the newest at the top under the box. */
  order?: 'newest-first' | 'newest-last';
  /** Offered at the older end while the caller has older posts to read; pressing it reports `action`. */
  older?: { label: string; action: ThreadAction };
  /** The reactions offered on every post whose `react` is set. */
  palette?: OfferedReaction[];
};
export type ThreadActionHandler = (action: ThreadAction, values: Record<string, string>) => Promise<unknown> | unknown;

const WORDS: Required<ThreadWords> = { collapse: 'Hide replies', expand: 'Show replies', cancel: 'Cancel', menu: 'More', theirs: '{count} posts here' };

/** What every post in one thread reads beside its own description: the offered reactions, every post by its author
 *  (so a face opens what that person wrote here), and the one handler. */
type ThreadShared = { palette: OfferedReaction[]; byAuthor: Map<string, ThreadPost[]>; onAction: ThreadActionHandler; words: Required<ThreadWords> };
const Shared = React.createContext<ThreadShared | null>(null);

const flat = (posts: readonly ThreadPost[]): ThreadPost[] => posts.flatMap(post => [post, ...flat(post.replies ?? [])]);
const excerpt = (words: string) => (words.length > 80 ? `${words.slice(0, 79).trimEnd()}…` : words);

/** The reactions on a post and the way to add one, when the reader may react. */
function Reactions({ post, compact = false }: { post: ThreadPost; compact?: boolean }) {
  const shared = React.useContext(Shared);
  if (!shared || !post.react || post.withdrawn) return null;
  const react = post.react;
  return (
    <ReactionRow reactions={post.reactions ?? []} palette={post.palette ?? shared.palette} compact={compact}
      onReact={choice => Promise.resolve(shared.onAction(react, { post: post.id, on: String(choice.on), ...(choice.symbol ? { symbol: choice.symbol } : {}), ...(choice.glyph ? { glyph: choice.glyph } : {}) }))} />
  );
}

/** One post as it opens in a card from its author's face: its words, its reactions and its reply box, in place. */
function PostPeek({ post }: { post: ThreadPost }) {
  const shared = React.useContext(Shared);
  if (!shared) return null;
  return (
    <div className="thread-peek" data-post={post.id}>
      <p className="thread-peek-when">{post.when}</p>
      <PostBody post={post} onAction={shared.onAction} />
      <div className="thread-actions"><Reactions post={post} compact /></div>
      {post.reply && !post.withdrawn ? <Box placeholder={post.reply_placeholder ?? post.reply.label} action={post.reply} onAction={shared.onAction} words={shared.words} /> : null}
    </div>
  );
}

/** A post's face and name: resting on them opens who they are and what else they wrote here, to reply in place. */
/** What a post was sent through, after its author: the app's mark and its name. */
function Via({ via }: { via: NonNullable<ThreadPost['via']> }) {
  return (
    <span className="thread-via" title={`Sent from ${via.name}`}>
      {/* An app is a thing: its own picture, or an app glyph, never letters. */}
      <DisplayMark key={via.picture ?? ''} spec={{ name: via.name, shape: 'tile', glyph: 'AppWindow', ...(via.picture ? { image: via.picture } : {}) }} size="xs" />
      <span className="thread-via-name">{via.name}</span>
    </span>
  );
}

function Author({ post, children }: { post: ThreadPost; children: React.ReactNode }) {
  const shared = React.useContext(Shared);
  const theirs = (shared?.byAuthor.get(post.author) ?? []).filter(one => !one.withdrawn);
  if (!shared) return <>{children}</>;
  return (
    <PersonHover name={post.author} things={theirs.map(one => ({ id: one.id, title: excerpt(one.body || one.attachment?.title || ''), ...(one.when ? { when: one.when } : {}) }))}
      countWords={count => shared.words.theirs.replace('{count}', String(count))}
      drawThing={id => { const one = theirs.find(candidate => candidate.id === id); return one ? <PostPeek post={one} /> : null; }}>
      {children}
    </PersonHover>
  );
}
/** Posts beyond this many are windowed; below it they are plain rows. */
const WINDOW_FROM = 60;

/** `onSent` runs once the words are sent (a card unfolds its replies so the new one shows); `onDone` also runs on Cancel. */
function Box({ placeholder, action, onAction, onDone, onSent, words, autoFocus = false }: { placeholder: string; action: ThreadAction; onAction: ThreadActionHandler; onDone?: () => void; onSent?: () => void; words?: Required<ThreadWords>; autoFocus?: boolean }) {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await onAction(action, { text: text.trim() }); setText(''); onSent?.(); onDone?.(); } finally { setBusy(false); }
  };
  return (
    <div className="thread-box">
      <Textarea className="thread-box-text" placeholder={placeholder} value={text} autoFocus={autoFocus} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send(); }} />
      <div className="thread-box-actions">
        <Button type="button" size="sm" loading={busy} disabled={!text.trim()} onClick={send}>{action.label}</Button>
        {onDone ? <Button type="button" size="sm" variant="ghost" onClick={() => { setText(''); onDone(); }}>{words?.cancel ?? WORDS.cancel}</Button> : null}
      </div>
    </div>
  );
}

/** A press that reports `action` and shows it is working until the caller answers. */
function PressAction({ action, values, onAction, variant = 'ghost', className }: { action: ThreadAction; values: Record<string, string>; onAction: ThreadActionHandler; variant?: 'ghost' | 'outline'; className?: string }) {
  const [busy, setBusy] = React.useState(false);
  const press = async () => {
    setBusy(true);
    try { await onAction(action, values); } finally { setBusy(false); }
  };
  return <Button type="button" size="sm" variant={variant} className={className} loading={busy} onClick={press}>{action.label}</Button>;
}

function Attachment({ post, attachment, onAction }: { post: ThreadPost; attachment: ThreadAttachment; onAction: ThreadActionHandler }) {
  // A picture of the thing itself shows; a kind's glyph tile would only say its kind a second time beside the mark.
  const picture = attachment.preview && attachment.preview.renderer !== 'type-icon' ? attachment.preview : null;
  return (
    <div className="thread-attachment" data-kind={attachment.kind} data-picture={picture ? '' : undefined}>
      {picture ? <div className="thread-attachment-picture"><MediaPreview {...picture} /></div> : null}
      <div className="thread-attachment-main">
        <RecordKindMark kind={attachment.kind} />
        <p className="thread-attachment-title">{attachment.title}</p>
        {attachment.detail ? <p className="thread-attachment-detail">{attachment.detail}</p> : null}
      </div>
      {attachment.open ? <PressAction action={attachment.open} values={{ post: post.id }} onAction={onAction} variant="outline" className="thread-attachment-open" /> : null}
    </div>
  );
}

function PostMenu({ post, onAction, words }: { post: ThreadPost; onAction: ThreadActionHandler; words: Required<ThreadWords> }) {
  const rows = post.menu;
  if (!rows?.length || post.withdrawn) return null;
  const choose = (id: string) => {
    const row = rows.find(candidate => candidate.id === id);
    if (row) void onAction({ id: row.id, label: row.label }, { post: post.id });
  };
  return <span className="thread-menu"><ActionMenu label={words.menu} items={rows} onAction={choose} align="end" /></span>;
}

/** The words of a post, or the quiet line that stands in for words taken back. */
function PostBody({ post, onAction }: { post: ThreadPost; onAction: ThreadActionHandler }) {
  if (post.withdrawn) return <p className="thread-withdrawn">{post.withdrawn}</p>;
  return (
    <>
      {post.part?.quote ? <blockquote className="thread-quote">{post.part.quote}</blockquote> : null}
      {post.body ? <p className="thread-body"><MentionWords text={post.body} mentions={post.mentions ?? []} /></p> : null}
      {post.attachment ? <Attachment post={post} attachment={post.attachment} onAction={onAction} /> : null}
    </>
  );
}

function Replies({ replies, depth, onAction, words }: { replies: ThreadPost[]; depth: number; onAction: ThreadActionHandler; words: Required<ThreadWords> }) {
  return (
    <div className="thread-replies" role="list">
      {replies.map(reply => <Post key={reply.id} post={reply} depth={depth} onAction={onAction} words={words} />)}
    </div>
  );
}

function Post({ post, depth, onAction, words }: { post: ThreadPost; depth: number; onAction: ThreadActionHandler; words: Required<ThreadWords> }) {
  const [open, setOpen] = React.useState(true);
  const [replying, setReplying] = React.useState(false);
  const replies = post.replies ?? [];
  const live = !post.withdrawn;
  return (
    <div className="thread-post" role="listitem" data-depth={depth} data-post={post.id} data-withdrawn={post.withdrawn ? '' : undefined}>
      <div className="thread-card">
        <Author post={post}><DisplayMark spec={{ name: post.author }} size="md" /></Author>
        <div className="thread-main">
          <div className="thread-meta">
            <Author post={post}><span className="thread-author">{post.author}</span></Author>
            {post.via ? <Via via={post.via} /> : null}
            {post.when ? <span className="thread-when">{post.when}</span> : null}
            {post.tag ? <Badge variant="outline" className="thread-tag">{post.tag}</Badge> : null}
            <PostMenu post={post} onAction={onAction} words={words} />
          </div>
          <PostBody post={post} onAction={onAction} />
          <div className="thread-actions">
            {live ? <Vote post={post} onAction={onAction} /> : null}
            <Reactions post={post} />
            {live && post.reply ? (
              <Button type="button" variant="ghost" size="sm" className="thread-action" aria-expanded={replying} onClick={() => setReplying(!replying)}>
                <ReplyIcon aria-hidden />{post.reply.label}
              </Button>
            ) : null}
            {replies.length ? (
              <Button type="button" variant="ghost" size="sm" className="thread-action thread-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
                <MessageSquare aria-hidden />{open ? words.collapse : `${words.expand} (${replies.length})`}
              </Button>
            ) : null}
          </div>
          {replying && live && post.reply ? <Box placeholder={post.reply_placeholder ?? post.reply.label} action={post.reply} onAction={onAction} onDone={() => setReplying(false)} words={words} autoFocus /> : null}
        </div>
      </div>
      {open && replies.length ? <Replies replies={replies} depth={depth + 1} onAction={onAction} words={words} /> : null}
    </div>
  );
}

function Vote({ post, onAction }: { post: ThreadPost; onAction: ThreadActionHandler }) {
  const [voting, setVoting] = React.useState(false);
  if (typeof post.score !== 'number' && !post.vote) return null;
  const vote = async () => {
    if (!post.vote) return;
    setVoting(true);
    try { await onAction(post.vote, {}); } finally { setVoting(false); }
  };
  return (
    <span className="thread-vote" data-voted={post.voted ? '' : undefined}>
      {post.vote ? (
        <Button type="button" variant="ghost" size="icon-sm" className="thread-vote-button" aria-pressed={post.voted ?? false} aria-label={post.vote.label} title={post.vote.label} disabled={voting} onClick={vote}>
          <ChevronUp aria-hidden />
        </Button>
      ) : <ChevronUp aria-hidden className="thread-vote-mark" />}
      <span className="thread-score">{post.score ?? 0}</span>
    </span>
  );
}

/** One top-level post as its own card: its replies start folded and unfold inside it. */
function PostCard({ post, onAction, words }: { post: ThreadPost; onAction: ThreadActionHandler; words: Required<ThreadWords> }) {
  const [open, setOpen] = React.useState(false);
  const [replying, setReplying] = React.useState(false);
  const replies = post.replies ?? [];
  const live = !post.withdrawn;
  return (
    <div className="thread-post thread-post-card" role="listitem" data-depth={0} data-post={post.id} data-withdrawn={post.withdrawn ? '' : undefined}>
      <div className="thread-post-card-top">
        <Author post={post}><DisplayMark spec={{ name: post.author }} size="md" /></Author>
        <div className="thread-meta">
          <Author post={post}><span className="thread-author">{post.author}</span></Author>
          {post.via ? <Via via={post.via} /> : null}
          {post.tag ? <Badge variant="outline" className="thread-tag">{post.tag}</Badge> : null}
          {post.when ? <span className="thread-post-card-when">{post.when}</span> : null}
        </div>
        <PostMenu post={post} onAction={onAction} words={words} />
      </div>
      <PostBody post={post} onAction={onAction} />
      <div className="thread-post-card-foot">
        {live ? <Vote post={post} onAction={onAction} /> : null}
        <Reactions post={post} />
        {replies.length ? (
          <Button type="button" variant="ghost" size="sm" className="thread-action thread-fold" aria-expanded={open} aria-label={open ? words.collapse : `${words.expand} (${replies.length})`} title={open ? words.collapse : words.expand} onClick={() => setOpen(!open)}>
            <MessageSquare aria-hidden />{replies.length}
          </Button>
        ) : null}
        {live && post.reply ? (
          <Button type="button" variant="ghost" size="sm" className="thread-action" aria-expanded={replying} onClick={() => setReplying(!replying)}>
            <ReplyIcon aria-hidden />{post.reply.label}
          </Button>
        ) : null}
      </div>
      {replying && live && post.reply ? <Box placeholder={post.reply_placeholder ?? post.reply.label} action={post.reply} onAction={onAction} onDone={() => setReplying(false)} onSent={() => setOpen(true)} words={words} autoFocus /> : null}
      {open && replies.length ? <Replies replies={replies} depth={1} onAction={onAction} words={words} /> : null}
    </div>
  );
}

/** Keeps the newest post in view while the reader is already at the newest end: true at the first draw, then whenever
 *  the end marker is on screen (read by an IntersectionObserver where the page has one). */
function useFollowNewest(marker: React.RefObject<HTMLDivElement | null>, newestId: string | undefined, active: boolean) {
  const following = React.useRef(true);
  React.useEffect(() => {
    const node = marker.current;
    if (!active || !node || typeof IntersectionObserver !== 'function') return undefined;
    const watch = new IntersectionObserver(entries => { following.current = entries.some(entry => entry.isIntersecting); });
    watch.observe(node);
    return () => watch.disconnect();
  }, [marker, active]);
  React.useLayoutEffect(() => {
    const node = marker.current;
    if (!active || !node || !following.current || typeof node.scrollIntoView !== 'function') return;
    node.scrollIntoView({ block: 'end', inline: 'nearest' });
  }, [marker, newestId, active]);
}

export function Thread({ thread, onAction }: { thread: ThreadDescription; onAction: ThreadActionHandler }) {
  const words: Required<ThreadWords> = { ...WORDS, ...thread.words };
  const shared = React.useMemo<ThreadShared>(() => {
    const byAuthor = new Map<string, ThreadPost[]>();
    for (const post of flat(thread.posts)) byAuthor.set(post.author, [...(byAuthor.get(post.author) ?? []), post]);
    return { palette: thread.palette ?? [], byAuthor, onAction, words };
    // words is rebuilt from thread.words each draw; its parts are what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.posts, thread.palette, onAction, thread.words]);
  const cards = thread.style === 'cards';
  const newestLast = thread.order === 'newest-last';
  const drawn = React.useMemo(() => (newestLast ? [...thread.posts].reverse() : thread.posts), [thread.posts, newestLast]);
  const end = React.useRef<HTMLDivElement>(null);
  useFollowNewest(end, thread.posts[0]?.id, newestLast);
  const compose = thread.compose ? <div className="thread-compose"><Box placeholder={thread.compose.placeholder} action={thread.compose.action} onAction={onAction} words={words} /></div> : null;
  const older = thread.older && thread.posts.length ? <div className="thread-older"><PressAction action={thread.older.action} values={{}} onAction={onAction} /></div> : null;
  const posts = thread.posts.length ? (
    <div className="thread-posts" role="list">
      <VirtualList
        items={drawn}
        itemKey={post => post.id}
        renderItem={post => (cards ? <PostCard post={post} onAction={onAction} words={words} /> : <Post post={post} depth={0} onAction={onAction} words={words} />)}
        estimateSize={() => (cards ? 160 : 110)}
        threshold={WINDOW_FROM}
        scrollParent="nearest"
        rowGap={12}
      />
    </div>
  ) : thread.empty ? <p className="thread-empty">{thread.empty}</p> : null;
  return (
    <Shared.Provider value={shared}>
      <div className="thread" data-style={thread.style ?? 'discussion'} data-order={newestLast ? 'newest-last' : 'newest-first'}>
        {newestLast ? <>{older}{posts}<div ref={end} className="thread-end" aria-hidden="true" />{compose}</> : <>{compose}{posts}{older}</>}
      </div>
    </Shared.Provider>
  );
}
