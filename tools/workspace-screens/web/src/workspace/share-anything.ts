// src/workspace/share-anything.ts
//
// PURPOSE
//   The page's one road to sharing: tool:share-anything run through the one Workshop tool run (workshop-tool-api.ts).
//   The sharing sheet, the board's share and the notes' Copy link all share a record, a list, one piece of text or a
//   mixed collection through here, so there is one record shape, one set of keys and one place a link is made. A thing
//   is shared with named people or AIs (each gets a key of its own) and/or by one link anyone may open; either way the
//   key is returned once, at the moment it is made, and this page never keeps it: only the run's answer in memory.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind of record. A record's kind is read from its id by `typeOf`, one rule.
//   2. A key or link is shown once, to the person who made it; nothing here writes it to a record, a log or storage.
//   3. Who has access is the tool's own `access` answer; the page never keeps a second list of it.
//   4. A text is read back from a link only through that link's own `.json` answer (readSharedText).

import { runWorkshopTool } from './workshop-tool-api';

export const SHARE_TOOL = 'tool:share-anything';
const LINK_PATH = /\/share\/([^/?#]+?)(?:\.json)?(?:[/?#]|$)/;

/** One thing in a mixed collection: a record kind with one id, an id prefix, or all of that kind; or a piece of text. */
export type ShareEntry = { type: string; id?: string; prefix?: string } | { text: string; title?: string };
/** What is shared: one record, a list (with its rows), one piece of text, or a mixed collection. */
export type ShareThing =
  | { type: string; id: string }
  | { list: string }
  | { text: string; title?: string }
  | { items: ShareEntry[]; title: string };
export type SharedWith = { principal: string; key?: string; url?: string };
export type Shared = { label: string; title: string; people: SharedWith[]; link?: { key: string; url: string }; said: string };
export type Access = {
  label: string | null;
  title: string | null;
  people: { principal: string; added_at?: string }[];
  link: { open: boolean; expires_at?: string | null; created_at?: string } | null;
};

/** One thing the person shares now, with who it is shared with. */
export type ShareRow = { label: string; title: string; items?: number; people: { principal: string; added_at?: string }[]; link: Access['link'] };

/** The record kind an id names: `record:<row kind>:<id>` is of kind `record:<row kind>`, every other id is of the kind
 *  before its first colon. A caller that knows the kind says it (`type`). */
export function typeOf(id: string, type?: string): string {
  if (type) return type;
  const parts = id.split(':');
  return parts[0] === 'record' && parts.length > 2 ? `${parts[0]}:${parts[1]}` : parts[0];
}

/** The thing a record id names: a list (shared with its rows) or one record. */
export function thingOf(id: string, type?: string): ShareThing {
  const kind = typeOf(id, type);
  return kind === 'list' && !type ? { list: id } : { type: kind, id };
}

const origin = () => window.location.origin;

/** Share a thing with named people or AIs and/or by one link. Answers each key and link once. */
export async function shareThing(
  thing: ShareThing,
  { people = [], link = false, until }: { people?: string[]; link?: boolean; until?: string | null } = {},
): Promise<Shared> {
  const ran = await runWorkshopTool<Shared>(SHARE_TOOL, {
    op: 'share', thing, origin: origin(), can: 'view',
    ...(people.length ? { with: people.map(principal => ({ principal })) } : {}),
    ...(link ? { link: true } : {}),
    ...(until ? { until } : {}),
  });
  return ran.result as Shared;
}

/** Take one person's access away, or stop the link. */
export async function stopSharing(label: string, who: { principal: string } | { link: true }): Promise<void> {
  await runWorkshopTool(SHARE_TOOL, { op: 'stop', label, ...who });
}

/** Who can open a thing now. */
export async function readAccess(thing: ShareThing): Promise<Access> {
  const ran = await runWorkshopTool<Access>(SHARE_TOOL, { op: 'access', thing });
  return ran.result as Access;
}

/** Everything the person shares now. */
export async function listShares(): Promise<ShareRow[]> {
  const ran = await runWorkshopTool<{ shares: ShareRow[] }>(SHARE_TOOL, { op: 'list' });
  return ran.result?.shares ?? [];
}

/** One piece of text shared by a link anyone may open: the link's address. */
export async function shareText(title: string, text: string): Promise<string> {
  const shared = await shareThing({ text, title }, { link: true });
  if (!shared.link) throw new Error('The link could not be made.');
  return shared.link.url;
}

/** Whether a pasted text is a share link (an address ending in /share/<code>). */
export const isShareLink = (text: string): boolean => /^https?:\/\/\S+$/.test(text.trim()) && LINK_PATH.test(text.trim());

/** The words a share link holds, read from its own `.json` answer (the first item that is a piece of text); null when
 *  the link is not open or holds none. */
export async function readSharedText(link: string): Promise<string | null> {
  const at = new URL(link.trim());
  const code = LINK_PATH.exec(at.pathname)?.[1];
  if (!code) return null;
  const answer = await fetch(`${at.origin}/share/${code}.json`, { headers: { accept: 'application/json' } });
  if (!answer.ok) return null;
  const items = ((await answer.json()) as { items?: { value?: { text?: unknown } }[] }).items ?? [];
  const found = items.find(item => typeof item.value?.text === 'string');
  return typeof found?.value?.text === 'string' ? found.value.text : null;
}
