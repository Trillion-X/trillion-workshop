// parts/ui/show/responses/SelectionResponses.tsx
//
// PURPOSE
//   Answer any words on any screen where they are: selecting words anywhere opens a small bar above them with Comment
//   and, where the thing they belong to takes reactions, its reactions in one press. Comment opens a box beside the
//   words, showing them quoted, and sends what is written about exactly those words. The host says, for the words
//   under the selection, which thing they belong to and how an answer to it is kept (`targetOf`); this layer never
//   knows what the thing is, so every screen that draws words gets it without code of its own.
//   Grounded on 21st.dev "Selection Bubble Menu" #26926 (laziekiki: a bar that springs up above any selection, keeps
//   the selection while pressed, flips below when there is no room) and Cofounder's comment-on-selection box as Mobbin
//   shows it (the quoted words, a box, Send), with Descript's range comments for the quote above the words.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Names no screen, record, store or product word: the host's `targetOf` answers everything about the thing.
//   2. The selection is read once when the bar opens; pressing in the bar or typing in the box never loses it, and the
//      box keeps its words until it is sent, Escape is pressed, or the person presses outside it.
//   3. Every press is the button's own work (pending, then done or the failure inside it).
//   4. Controls are the licensed coss Popover, Button and Textarea and the shared ReactionRow glyph; appearance lives in
//      screen-look/show/reactions.css (`.selection-responses*`).
//   5. Words selected inside a locked region (ui/show/locked-region) open nothing: no comment, reaction or highlight
//      bar; the person can still select and copy them.
//   6. The bar is the control `selection.responses` (show-rules show-of.ts controlShown): while a show rule hides it,
//      selecting words opens nothing, the same as in a locked region.

import * as React from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { Button } from '../coss/ui/button';
import { Textarea } from '../coss/ui/textarea';
import { Popover, PopoverPopup } from '../coss/ui/popover';
import { ReactionRow, type OfferedReaction, type ReactionChoice, type Reaction } from '../reactions/ReactionRow';
import { textPartOf, type TextPart } from './text-part';
import { isLockedAt } from '../locked-region';
import { controlShown, useShowChange } from '../show-rules/show-of';
import { SELECTION_COMMENT_REQUEST } from './selection-comment-request';

/** The control the bar above selected words is decided under. */
export const RESPONSES_CONTROL = 'selection.responses';

/** What the host says about the thing under some selected words. `root` is the element whose text the words are
 *  counted in; `comment` keeps words about them; `react`, when the thing takes reactions, gives one to it. */
export type ResponsePart = TextPart | { kind: 'element'; page_path: string; element?: string; selector?: string };
export type SelectionTarget = {
  root: Element;
  /** Space-scoped show rules use this id only after the host verifies membership through its authenticated Space read. */
  space_id?: string;
  /** Who will read a comment, in words ("Everyone in Kitchen renovation", "Your AIs"). */
  audience: string;
  comment: (part: ResponsePart, text: string, replyTo?: string) => Promise<unknown>;
  readComments?: (part: ResponsePart, cursor?: string) => Promise<SelectionCommentPage>;
  subscribeComments?: (reload: () => void) => () => void;
  react?: (choice: ReactionChoice, part: ResponsePart) => Promise<{ reactions?: Reaction[] }>;
  readReactions?: (part: ResponsePart) => Promise<{ reactions?: Reaction[] }>;
};
export type SelectionComment = { id: string; text: string; by: string; at?: string | null; replyTo?: string | null };
export type SelectionCommentPage = { comments: SelectionComment[]; next?: string | null };
export type SelectionWords = { comment: string; placeholder: string; send: string; cancel: string; reply: string; replying: string; empty: string; loading: string; failed: string; retry: string; more: string };
const WORDS: SelectionWords = { comment: 'Comment', placeholder: 'Write a comment', send: 'Send', cancel: 'Cancel', reply: 'Reply', replying: 'Replying to', empty: 'No comments yet', loading: 'Opening comments…', failed: 'Comments could not be opened.', retry: 'Try again', more: 'Show more' };
const SETTLE_MS = 180;
const EXIT_MS = 160;

// `range` is the selection as it was read, so the bar is placed on the words where they are now (a page that scrolls
// or reflows after selecting moves the bar with them); `seen` is the last place they were seen drawn, for words the
// page has since drawn away.
type Open = { target: SelectionTarget; part: TextPart; range: Range; words: string };

export function SelectionResponses({ targetOf, palette = [], words: given }: {
  targetOf: (node: Node) => SelectionTarget | null; palette?: readonly OfferedReaction[]; words?: Partial<SelectionWords>;
}) {
  const words = { ...WORDS, ...given };
  const [open, setOpen] = React.useState<Open | null>(null);
  const [closing, setClosing] = React.useState(false);
  const [writing, setWriting] = React.useState(false);
  const showRevision = useShowChange();
  const [text, setText] = React.useState('');
  const draftRevision = React.useRef(0);
  const [reactions, setReactions] = React.useState<Reaction[]>([]);
  const [comments, setComments] = React.useState<SelectionComment[]>([]);
  const [commentsNext, setCommentsNext] = React.useState<string | null>(null);
  const [commentsLoading, setCommentsLoading] = React.useState(false);
  const [commentsFailed, setCommentsFailed] = React.useState(false);
  const [replyTo, setReplyTo] = React.useState<SelectionComment | null>(null);
  const reactionRead = React.useRef(0);
  const commentRead = React.useRef(0);
  const popup = React.useRef<HTMLDivElement>(null);
  const holding = React.useRef(false);
  const threadOpen = React.useRef(false);
  const seen = React.useRef<DOMRect | null>(null);
  const exitTimer = React.useRef<number | null>(null);
  const openRef = React.useRef(open);
  const closingRef = React.useRef(false);
  openRef.current = open;
  const replaceOpen = React.useCallback((next: Open | null) => {
    openRef.current = next;
    setOpen(next);
  }, []);
  holding.current = writing && text.trim().length > 0;
  threadOpen.current = writing;

  const close = React.useCallback(() => {
    if (!openRef.current || closingRef.current) return;
    ++reactionRead.current;
    ++commentRead.current;
    closingRef.current = true;
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    setClosing(true);
    exitTimer.current = window.setTimeout(() => {
      replaceOpen(null);
      setClosing(false);
      closingRef.current = false;
      setWriting(false);
      setText('');
      setReplyTo(null);
      exitTimer.current = null;
    }, EXIT_MS);
  }, [replaceOpen]);

  React.useEffect(() => {
    let timer = 0;
    const read = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const selection = document.getSelection();
        const focus = document.activeElement;
        // Typing in a box of the bar, or in any field, is never a selection to answer.
        if (focus && (popup.current?.contains(focus) || focus.closest('input, textarea, [contenteditable="true"]'))) return;
        // Sending clears the draft and the page may collapse its selection while it redraws.
        // Keep the opened thread so Reply is still usable until the person dismisses it.
        if (!selection || selection.isCollapsed || !selection.rangeCount) { if (!threadOpen.current) close(); return; }
        const range = selection.getRangeAt(0);
        // Editors retain a DOM range when a toolbar or page menu takes focus.
        // Their own toolbar explicitly requests a thread; an automatic bubble
        // here would steal focus and dismiss that menu after it opened.
        const editableAt = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('[contenteditable="true"]');
        if (editableAt(range.startContainer) || editableAt(range.endContainer)) {
          if (!holding.current && !threadOpen.current) close();
          return;
        }
        // Words inside a locked region are answered by nothing but that region's own controls (invariant 5).
        if (isLockedAt(range.startContainer) || isLockedAt(range.endContainer)) { close(); return; }
        const rect = range.getBoundingClientRect();
        // Words the page already drew away, or that take no room, have nowhere to be answered.
        if (!range.commonAncestorContainer.isConnected || (!rect.width && !rect.height)) { if (!holding.current) close(); return; }
        // A preview can be nested in another record. The common ancestor may be the outer card,
        // so use the selected words' endpoints and never attach a cross-record quote to either one.
        const target = targetOf(range.startContainer);
        const last = targetOf(range.endContainer);
        if (!target || !last || target.root !== last.root) { if (!holding.current) close(); return; }
        if (!controlShown(RESPONSES_CONTROL, { space_id: target.space_id })) { close(); return; }
        const part = target ? textPartOf(target.root, range) : null;
        if (!target || !part) { if (!holding.current) close(); return; }
        seen.current = rect;
        if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
        exitTimer.current = null;
        closingRef.current = false;
        setClosing(false);
        replaceOpen({ target, part, range: range.cloneRange(), words: range.toString() });
        ++commentRead.current;
        setComments([]);
        setCommentsNext(null);
        setCommentsFailed(false);
        setReplyTo(null);
        const readId = ++reactionRead.current;
        setReactions([]);
        if (target.readReactions) void target.readReactions(part).then(answer => {
          if (reactionRead.current === readId) setReactions(answer.reactions ?? []);
        }).catch(() => undefined);
        setWriting(false);
        setText('');
        setReplyTo(null);
      }, SETTLE_MS);
    };
    document.addEventListener('selectionchange', read);
    return () => { window.clearTimeout(timer); document.removeEventListener('selectionchange', read); };
  }, [close, targetOf, replaceOpen]);

  React.useEffect(() => () => { if (exitTimer.current !== null) window.clearTimeout(exitTimer.current); }, []);

  const loadComments = React.useCallback(async (selected: Open, cursor?: string) => {
    if (!selected.target.readComments) return;
    const readId = ++commentRead.current;
    setCommentsLoading(true);
    setCommentsFailed(false);
    try {
      const page = await selected.target.readComments(selected.part, cursor);
      if (commentRead.current !== readId) return;
      setComments(previous => cursor ? [...previous, ...page.comments] : page.comments);
      setCommentsNext(page.next ?? null);
    } catch {
      if (commentRead.current === readId) setCommentsFailed(true);
    } finally {
      if (commentRead.current === readId) setCommentsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const request = (event: Event) => {
      const range = (event as CustomEvent<Range>).detail;
      if (!(range instanceof Range) || range.collapsed || !range.commonAncestorContainer.isConnected
        || isLockedAt(range.startContainer) || isLockedAt(range.endContainer)) return;
      const target = targetOf(range.startContainer);
      const last = targetOf(range.endContainer);
      if (!target || !last || target.root !== last.root) return;
      if (!controlShown(RESPONSES_CONTROL, { space_id: target.space_id }) || !controlShown('comments', { space_id: target.space_id })) return;
      const part = textPartOf(target.root, range);
      if (!part) return;
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      event.preventDefault();
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
      exitTimer.current = null;
      closingRef.current = false;
      seen.current = rect;
      ++reactionRead.current;
      ++commentRead.current;
      setClosing(false);
      const selected = { target, part, range: range.cloneRange(), words: range.toString() };
      replaceOpen(selected);
      setWriting(true);
      setText('');
      setReplyTo(null);
      setComments([]);
      setCommentsNext(null);
      setCommentsFailed(false);
      void loadComments(selected);
    };
    document.addEventListener(SELECTION_COMMENT_REQUEST, request);
    return () => document.removeEventListener(SELECTION_COMMENT_REQUEST, request);
  }, [targetOf, loadComments, replaceOpen]);

  React.useEffect(() => {
    if (!writing || !open?.target.subscribeComments) return;
    return open.target.subscribeComments(() => { void loadComments(open); });
  }, [writing, open, loadComments]);

  React.useEffect(() => {
    if (!open) return;
    const context = { space_id: open.target.space_id };
    if (!controlShown(RESPONSES_CONTROL, context) || (writing && !controlShown('comments', context))) close();
  }, [open, writing, close, showRevision]);

  if (!open) return null;
  const commentsShown = controlShown('comments', { space_id: open.target.space_id });
  // The words where they are now while they are still the words selected and drawn; once the page redraws them away,
  // the last place they were seen, so the bar and the box never fall to the page corner.
  const anchor = { getBoundingClientRect: () => {
    const live = open.range.startContainer.isConnected && open.range.toString() === open.words ? open.range.getBoundingClientRect() : null;
    if (live && (live.width || live.height)) seen.current = live;
    return seen.current ?? new DOMRect();
  } };
  const send = async () => {
    const selected = open, revision = draftRevision.current;
    await selected.target.comment(selected.part, text.trim(), replyTo?.id);
    // A late result belongs to its original thread and submitted draft.
    if (openRef.current !== selected || closingRef.current) return;
    if (draftRevision.current === revision) { setText(''); setReplyTo(null); }
    if (selected.target.readComments) await loadComments(selected);
    else window.setTimeout(() => {
      if (openRef.current === selected && draftRevision.current === revision) close();
    }, 700);
  };
  const react = async (choice: ReactionChoice) => {
    if (!open.target.react) return;
    ++reactionRead.current;
    const answer = await open.target.react(choice, open.part);
    if (openRef.current?.part === open.part) setReactions(answer.reactions ?? []);
  };
  return (
    <Popover open={!closing} onOpenChange={next => { if (!next && !holding.current && !closing) close(); }}>
      <PopoverPopup key={writing ? 'thread' : 'bar'} ref={popup} anchor={anchor} side={writing ? 'bottom' : 'top'} align="center" sideOffset={8} className="coss-ui selection-responses" data-writing={writing ? '' : undefined}>
        {writing ? (
          <div className="selection-responses-box">
            <blockquote className="selection-responses-quote">{open.part.quote}</blockquote>
            {open.target.readComments ? (
              <div className="selection-responses-thread" aria-live="polite">
                {comments.map(one => (
                  <div key={one.id} className="selection-responses-entry" data-reply={one.replyTo && comments.some(parent => parent.id === one.replyTo) ? '' : undefined}>
                    <span className="selection-responses-entry-by">{one.by}</span>
                    <p>{one.text}</p>
                    <Button type="button" size="xs" variant="ghost" onClick={() => { ++draftRevision.current; setReplyTo(one); popup.current?.querySelector('textarea')?.focus(); }}>{words.reply}</Button>
                  </div>
                ))}
                {commentsLoading ? <span>{words.loading}</span> : null}
                {commentsFailed ? <Button type="button" size="xs" variant="ghost" onClick={() => loadComments(open)}>{words.failed} {words.retry}</Button> : null}
                {!commentsLoading && !commentsFailed && !comments.length ? <span>{words.empty}</span> : null}
                {commentsNext && !commentsLoading ? <Button type="button" size="xs" variant="ghost" onClick={() => loadComments(open, commentsNext)}>{words.more}</Button> : null}
              </div>
            ) : null}
            {replyTo ? <span className="selection-responses-replying">{words.replying} {replyTo.by}</span> : null}
            <Textarea autoFocus value={text} placeholder={words.placeholder} aria-label={words.placeholder}
              onChange={event => { ++draftRevision.current; setText(event.target.value); }}
              onKeyDown={event => { if (event.key === 'Escape') close(); }} />
            <div className="selection-responses-foot">
              <span className="selection-responses-audience">{open.target.audience}</span>
              <Button type="button" size="xs" variant="ghost" onClick={close}>{words.cancel}</Button>
              <Button type="button" size="xs" disabled={!text.trim()} onClick={send}>{words.send}</Button>
            </div>
          </div>
        ) : (
          <div className="selection-responses-bar" role="toolbar" aria-label={words.comment}>
            {commentsShown ? <Button type="button" size="xs" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => { setWriting(true); void loadComments(open); }}>
              <MessageSquarePlus aria-hidden />{words.comment}
            </Button> : null}
            {open.target.react ? <ReactionRow palette={palette} reactions={reactions} onReact={react} compact /> : null}
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
