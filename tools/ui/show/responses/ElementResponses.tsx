import * as React from 'react';
import { Button } from '../coss/ui/button';
import { Textarea } from '../coss/ui/textarea';
import { ReactionRow, type OfferedReaction, type Reaction, type ReactionChoice } from '../reactions/ReactionRow';
import type { ResponsePart, SelectionTarget, SelectionComment } from './SelectionResponses';
import { controlShown, useShowChange } from '../show-rules/show-of';

/** Responses beside an element the person picked, using the same target and anchor as selected words. */
export function ElementResponses({ target, part, palette }: { target: SelectionTarget; part: Extract<ResponsePart, { kind: 'element' }>; palette: readonly OfferedReaction[] }) {
  useShowChange();
  const commentsShown = controlShown('comments', { space_id: target.space_id });
  const [reactions, setReactions] = React.useState<Reaction[]>([]);
  const [comments, setComments] = React.useState<SelectionComment[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const draftRevision = React.useRef(0);
  const openRevision = React.useRef(0);
  const context = React.useRef({ target, part });
  context.current = { target, part };
  const [reply, setReply] = React.useState<SelectionComment | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const readId = React.useRef(0);
  const load = React.useCallback(async (before?: string) => {
    if (!target.readComments) return;
    const id = ++readId.current;
    setLoading(true);
    setFailed(false);
    try {
      const page = await target.readComments(part, before);
      if (readId.current !== id) return;
      setComments(previous => before ? [...previous, ...page.comments] : page.comments);
      setCursor(page.next ?? null);
    } catch {
      if (readId.current === id) setFailed(true);
    } finally {
      if (readId.current === id) setLoading(false);
    }
  }, [target, part]);
  React.useEffect(() => {
    let current = true;
    setReactions([]);
    void target.readReactions?.(part).then(answer => { if (current) setReactions(answer.reactions ?? []); }).catch(() => undefined);
    return () => { current = false; ++readId.current; ++openRevision.current; };
  }, [target, part]);
  React.useEffect(() => {
    if (!open || !target.subscribeComments) return;
    return target.subscribeComments(() => { void load(); });
  }, [open, target, load]);
  const react = async (choice: ReactionChoice) => {
    if (!target.react) return;
    const answer = await target.react(choice, part);
    setReactions(answer.reactions ?? []);
  };
  const send = async () => {
    const opened = openRevision.current, draft = draftRevision.current;
    await target.comment(part, text.trim(), reply?.id);
    if (openRevision.current !== opened || context.current.target !== target || context.current.part !== part) return;
    if (draftRevision.current === draft) { setText(''); setReply(null); }
    await load();
  };
  return <div className="selection-responses-box" data-element-responses>
    <div className="selection-responses-bar">
      {commentsShown ? <Button type="button" size="xs" variant="ghost" onClick={() => { ++openRevision.current; setOpen(value => !value); if (!open) void load(); }}>Comment</Button> : null}
      {target.react ? <ReactionRow palette={palette} reactions={reactions} onReact={react} compact /> : null}
    </div>
    {open && commentsShown ? <>
      {target.readComments ? <div className="selection-responses-thread" aria-live="polite">
        {comments.map(one => <div key={one.id} className="selection-responses-entry" data-reply={one.replyTo && comments.some(parent => parent.id === one.replyTo) ? '' : undefined}>
          <span className="selection-responses-entry-by">{one.by}</span><p>{one.text}</p>
          <Button type="button" size="xs" variant="ghost" onClick={() => { ++draftRevision.current; setReply(one); }}>Reply</Button>
        </div>)}
        {loading ? <span>Opening comments…</span> : null}
        {failed ? <Button type="button" size="xs" variant="ghost" onClick={() => load()}>Comments could not be opened. Try again</Button> : null}
        {!loading && !failed && !comments.length ? <span>No comments yet</span> : null}
        {cursor && !loading ? <Button type="button" size="xs" variant="ghost" onClick={() => load(cursor)}>Show more</Button> : null}
      </div> : null}
      {reply ? <span className="selection-responses-replying">Replying to {reply.by}</span> : null}
      <Textarea aria-label="Write a comment" placeholder="Write a comment" value={text} onChange={event => { ++draftRevision.current; setText(event.target.value); }} />
      <div className="selection-responses-foot"><span className="selection-responses-audience">{target.audience}</span><Button type="button" size="xs" disabled={!text.trim()} onClick={send}>Send</Button></div>
    </> : null}
  </div>;
}
