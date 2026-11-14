// src/workspace/send-message.ts
//
// PURPOSE
//   How the web app sends what the person put in the shared composer (parts/ui/show/composer): its files go into the
//   person's own Files first (src/workspace/upload.ts, one folder per message beneath message-files.json `folder`),
//   then the message goes once, naming those files by identity, either to every AI on the account (/work/api/messages/
//   send-all, src/send-to-all-ais.mjs) or into a space (each file shared there, then the message about them).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Bytes move only through the one uploader; the message carries identities, never bytes.
//   2. Pasted links travel as words: each on its own line after what the person wrote.
//   3. A failure is thrown in the Worker's words, and nothing is reported sent unless the Worker said so.
//   4. Every message to the AIs carries a client id made here (`postToAllAis`): the same draft sent again after a failure
//      keeps its id, so the Worker keeps it once, and words typed again are a new draft with a new id, so the Worker
//      keeps them as a new message (src/send-to-all-ais.mjs client_id).
//   5. A message to the AIs is written to this device's outbox before it is posted (src/workspace/share-outbox.ts) and
//      sent again, under the same client id, until the account answers it, so a page closed or a connection lost mid-send
//      never loses it; the person is told it is kept (message-files.json `kept`), and `resend`/`cancel` there act on it.

import type { ComposerDraft } from '../../parts/ui/show/composer';
import { momentName } from '../../parts/record-audio/show/record-in-the-browser';
import { uploadFiles } from './upload';
import { linkPreviewProps, readLink } from './read-link';
import settings from './message-files.json';
import { admitAttachments } from '../attachment-admission.mjs';

/** What the person wrote, with each pasted link on its own line after it. */
export const wordsWithLinks = (draft: ComposerDraft) => [draft.text, ...draft.links].filter(part => part.trim()).join('\n');

/** The draft's files kept in the person's Files, in one new folder for this message. */
const uploadedDrafts = new WeakMap<ComposerDraft, ReturnType<typeof uploadFiles>>();

export async function keepFiles(draft: ComposerDraft, at = new Date()) {
  if (!draft.files.length) return [];
  const previous = uploadedDrafts.get(draft);
  if (previous) return previous;
  // Every surface admits the same prefix of the files and says which limit bound; nothing is dropped unsaid.
  const admitted = admitAttachments({ files: draft.files.map(file => ({ name: file.name, size: file.size })) });
  if (admitted.banner) throw new Error(admitted.banner);
  const pending = uploadFiles(draft.files, `${settings.folder}/${momentName(at)}`);
  uploadedDrafts.set(draft, pending);
  // A completed upload belongs to this draft even when sending its message loses the reply. Reusing the same
  // references keeps both the files and client id stable; an upload that failed may itself be tried again.
  void pending.catch(() => { if (uploadedDrafts.get(draft) === pending) uploadedDrafts.delete(draft); });
  return pending;
}

/** What a send answers: the Worker's own line about what happened, and the message it kept (whose work the place it
 *  was sent from shows being done, src/workspace/job-run.tsx). */
export type Sent = { said: string; message_id: string | null };

const draftIds = new WeakMap<object, { body: string; id: string }>();

/** The one road a message to the AIs takes (/work/api/messages/send-all), with the client id of the draft it sends: the
 *  same draft object keeps its id across a send that failed and is sent again; a send with no draft gets a new id. */
export function postToAllAis<T>(body: Record<string, unknown>, draft?: object): Promise<T> {
  const signature = JSON.stringify(body);
  const previous = draft ? draftIds.get(draft) : undefined;
  const id = previous?.body === signature ? previous.id : crypto.randomUUID();
  if (draft) draftIds.set(draft, { body: signature, id });
  return deliverKept<T>({ ...body, client_id: id });
}

/** The device outbox route a message to the AIs travels (message-files.json `route`), so it survives a closed page. */
const SEND_ALL = settings.route;

async function deliverKept<T>(body: Record<string, unknown>): Promise<T> {
  const { shareOutbox } = await import('./share-outbox');
  const result = await shareOutbox.deliver(body, SEND_ALL);
  if (result.state === 'sent') return result.answer as unknown as T;
  return { message: settings.kept, message_id: null, kept: true } as T;
}

/** Sends the draft once to every AI on the account. */
export async function sendToAllYourAis(draft: ComposerDraft): Promise<Sent> {
  const kept = await keepFiles(draft);
  const sent = await postToAllAis<{ message: string; message_id?: string }>({
    text: wordsWithLinks(draft), files: kept.map(file => ({ identity: file.identity })), mentions: draft.mentions,
  }, draft);
  return { said: sent.message, message_id: sent.message_id ?? null };
}

/** A pasted link read into its card by the one link reader (src/workspace/read-link.ts), for the composer's tray. */
export const readPastedLink = (url: string) => readLink(url).then(linkPreviewProps);
