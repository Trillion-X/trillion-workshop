// src/workspace/responses.tsx
//
// Answer any words on any screen of the workspace where they are (parts/ui/show/responses/SelectionResponses): this
// file says, for the words under a selection, which thing they belong to and where an answer to it is kept, in the
// one shape every store reads (src/responses.mjs: an anchor { record, part }).
//
//   - Words of a post in a space (an element with data-post inside one with data-response-space): the comment is a
//     reply to that post about those words, kept in the space for everyone in it (POST /work/api/spaces/<id>/items,
//     with reply_to and part), and a reaction is given to the post (POST .../items/<post>/react).
//   - Words of anything else that names its record (data-share-record, which every list row and card carries), or of
//     the screen itself (its address): the comment goes to the person's own AIs about that thing and those words, by
//     the one road a message to every AI takes (/work/api/messages/send-all with anchor), so any AI reads exactly what
//     was pointed at.
//
// Nothing here names a screen: a screen takes part by drawing its posts with data-post inside data-response-space, or
// its rows with data-share-record, which the shared thread and record views already do.
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { SelectionResponses, type SelectionTarget, type SelectionCommentPage } from '../../parts/ui/show/responses/SelectionResponses';
import { postJson, readJson } from './api';
import { postToAllAis } from './send-message';
import { AI_MESSAGES, onStoreChange } from './store-changes';
import reactions from '../reactions.json';

const SPACES = '/work/api/spaces';
const at = (id: string) => `${SPACES}/${encodeURIComponent(id)}`;
type SpaceComment = { item_id: string; kind: string; body?: { text?: string } | string | null; reply_to?: string | null; provenance?: { by?: string; added_at?: string } };
type PrivateComment = { id: string; text: string; speaker?: string | null; app?: string | null; at?: string | null; reply_to?: string | null };

async function spaceComments(spaceId: string, record: string, part: object, cursor?: string): Promise<SelectionCommentPage> {
  const query = new URLSearchParams({ record, part: JSON.stringify(part), limit: '40', ...(cursor ? { before: cursor } : {}) });
  const answer = await readJson<{ items: SpaceComment[]; next_after?: string | null }>(`${at(spaceId)}/responses?${query}`);
  return { comments: answer.items.filter(item => item.kind === 'message').map(item => ({
    id: item.item_id, text: typeof item.body === 'string' ? item.body : item.body && typeof item.body === 'object' ? item.body.text ?? '' : '',
    by: item.provenance?.by ?? 'Member', at: item.provenance?.added_at, replyTo: item.reply_to,
  })), next: answer.next_after ?? null };
}

async function privateComments(record: string, part: object, cursor?: string): Promise<SelectionCommentPage> {
  const query = new URLSearchParams({ record, part: JSON.stringify(part), limit: '40', ...(cursor ? { before: cursor } : {}) });
  const answer = await readJson<{ notes: PrivateComment[]; next_before?: string | null }>(`/work/api/messages/about?${query}`);
  return { comments: answer.notes.map(note => ({ id: note.id, text: note.text, by: note.speaker === 'person' ? 'You' : note.app ?? note.speaker ?? 'Your AI', at: note.at, replyTo: note.reply_to })), next: answer.next_before ?? null };
}

/** The words a post's own text is counted in: its words, else the shared thing it carries, else the post. */
const postRoot = (post: Element, inside: Element) => inside.closest('.thread-body, .thread-attachment') ?? post;

export function targetOf(node: Node): SelectionTarget | null {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element || element.closest('[data-no-responses], .selection-responses')) return null;
  // The closest address wins: a file or other preview inside a Space post belongs to
  // that preview, and a nested post inside a card belongs to the inner post.
  const addressed = element.closest<HTMLElement>('[data-post], [data-response-record], [data-share-record]');
  // A structured record can expose stable members. Count selected words inside
  // that member, so moving a block does not attach its thread to another block.
  const member = element.closest<HTMLElement>('[data-response-element]');
  const memberRoot = member && addressed?.contains(member) ? member : null;
  const anchorPart = (part: Parameters<SelectionTarget['comment']>[0]) =>
    memberRoot?.dataset.responseElement ? { ...part, element: memberRoot.dataset.responseElement } : part;
  const space = addressed?.closest<HTMLElement>('[data-response-space]');
  if (addressed?.dataset.post && space?.dataset.responseSpace) {
    const spaceId = space.dataset.responseSpace;
    const postId = addressed.dataset.post;
    return {
      root: memberRoot ?? postRoot(addressed, element),
      space_id: spaceId,
      audience: space.dataset.responseAudience ?? 'Everyone in this pursuit',
      comment: (part, text, parent) => postJson(`${at(spaceId)}/items`, { items: [{ kind: 'message', body: { text }, reply_to: parent ?? postId, ...(parent ? {} : { part: anchorPart(part) }), anchor: { record: postId, part: anchorPart(part) } }] }),
      readComments: (part, cursor) => spaceComments(spaceId, postId, anchorPart(part), cursor),
      subscribeComments: reload => onStoreChange(reload, AI_MESSAGES),
      react: choice => postJson(`${at(spaceId)}/items/${encodeURIComponent(postId)}/react`, { symbol: choice.symbol, glyph: choice.glyph, on: choice.on }),
      readReactions: () => readJson(`${at(spaceId)}/items/${encodeURIComponent(postId)}/reactions`),
    };
  }
  if (space?.dataset.responseSpace && addressed?.dataset.responseRecord) {
    const spaceId = space.dataset.responseSpace;
    const record = addressed.dataset.responseRecord;
    return {
      root: memberRoot ?? addressed,
      space_id: spaceId,
      audience: space.dataset.responseAudience ?? 'Everyone in this pursuit',
      comment: (part, text, parent) => postJson(`${at(spaceId)}/items`, { items: [{ kind: 'message', body: { text }, ...(parent ? { reply_to: parent } : {}), anchor: { record, part: anchorPart(part) } }] }),
      readComments: (part, cursor) => spaceComments(spaceId, record, anchorPart(part), cursor),
      subscribeComments: reload => onStoreChange(reload, AI_MESSAGES),
      // This picker does not load every reaction for every possible text range. Let the shared owner
      // toggle the exact reaction so a second press removes it instead of duplicating it.
      react: (choice, part) => postJson(`${at(spaceId)}/responses/react`, { record, part: anchorPart(part), symbol: choice.symbol, glyph: choice.glyph, on: choice.on }),
      readReactions: part => readJson(`${at(spaceId)}/responses?${new URLSearchParams({ record, part: JSON.stringify(anchorPart(part)) })}`),
    };
  }
  const record = addressed?.dataset.shareRecord || addressed?.dataset.responseRecord || addressed?.dataset.post || `page:${location.pathname}${location.search}`;
  const root = memberRoot ?? addressed ?? element.closest('[data-trillion-screen]') ?? document.body;
  return {
    root,
    audience: 'Your AIs',
    comment: (part, text, parent) => postToAllAis({ text, anchor: { record, part: anchorPart(part) }, ...(parent ? { reply_to: parent } : {}) }),
    readComments: (part, cursor) => privateComments(record, anchorPart(part), cursor),
    subscribeComments: reload => onStoreChange(reload, AI_MESSAGES),
    react: (choice, part) => postJson('/work/api/responses/react', { record, part: anchorPart(part), symbol: choice.symbol, glyph: choice.glyph, on: choice.on }),
    readReactions: part => readJson(`/work/api/responses?${new URLSearchParams({ record, part: JSON.stringify(anchorPart(part)) })}`),
  };
}

/** Starts the layer once for the page: it draws nothing until words are selected. */
export function publishResponses(): void {
  const host = document.createElement('div');
  host.className = 'trillion-responses';
  document.body.append(host);
  mountReactSurface(host, <SelectionResponses targetOf={targetOf} palette={reactions.palette} />);
}
