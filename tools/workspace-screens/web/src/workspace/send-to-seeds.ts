// src/workspace/send-to-seeds.ts
//
// PURPOSE
//   Where a message the person sends from the shared composer is kept: one row of the owner's own seeds table, in the
//   database the owner-places record names for the role `messages-to-my-ais` (send-to-seeds.json). The device outbox
//   (share-outbox.ts) posts a message to this route, so the message stays on this device until its row is written, and
//   a send again carries the same client id, which makes the row's id the same.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every read and write is one tool run (tool:run-sql-in-my-database) with the owner's credential name and
//      statement_timeout_ms; the only door address on this road is the tool run's own (workshop-tool-api.ts).
//   2. The row id is composer:<client id>: a message sent again answers the row already held (its kept_at), never a second row.
//   3. Words are DATA (send-to-seeds.json).

import { runWorkshopTool, type Ran } from './workshop-tool-api.ts';
import seeds from './send-to-seeds.json' with { type: 'json' };

/** The outbox route a composer message is kept under (its path and the body field its client id travels in). */
export const seedRoute = { path: seeds.route, key_field: seeds.key_field };

/** What the composer sends to the route: the words, the files by identity, the moment it was sent and where it came from. */
export type ComposerSeed = { client_id: string; text: string; at: string; files?: { identity: string }[]; anchor?: unknown; reply_to?: string };

/** What the person is told once the row is held. */
export type KeptSeed = { message: string; message_id: string; kept_at: string };

type Place = { credential_name: string; table: string };
/** One tool run; the key is the run's own idempotency key (the same key again is the same run). */
type Runner = <T>(tool: string, input: Record<string, unknown>, requestKey?: string) => Promise<Ran<T>>;

const TABLE_NAME = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/** The screen the person sent from: the first part of the page's address (`home` on the Home screen). */
const screenNow = () => (typeof location === 'undefined' ? '' : location.pathname.split('/').filter(Boolean)[0] ?? '');

/** The role's place from the owner-places record; null when the record has no such role. */
async function placeOf(run: Runner): Promise<Place | null> {
  const ran = await run<{ rows?: { value: string }[] }>(seeds.tool, {
    credential_name: seeds.roles.credential_name,
    sql: seeds.roles.sql,
    params: [seeds.roles.label],
    statement_timeout_ms: seeds.statement_timeout_ms,
  });
  const value = ran.result?.rows?.[0]?.value;
  const roles = value ? (JSON.parse(value) as { roles?: Record<string, Place> }).roles ?? {} : {};
  return roles[seeds.role] ?? null;
}

/** Keeps one composer message as its seed row and answers what the person is told about it. */
export async function keepComposerSeed(body: ComposerSeed, run: Runner = runWorkshopTool): Promise<KeptSeed> {
  const place = await placeOf(run);
  if (!place || !TABLE_NAME.test(place.table)) throw new Error(seeds.no_place);
  const came_from = { source: 'composer', screen: screenNow(), at: body.at, channel: 'web', ...(body.anchor ? { anchor: body.anchor } : {}), ...(body.reply_to ? { reply_to: body.reply_to } : {}) };
  const media = body.files?.length ? JSON.stringify(body.files) : null;
  const ran = await run<{ rows?: { id: string; kept_at: string }[] }>(seeds.tool, {
    credential_name: place.credential_name,
    sql: seeds.insert.replaceAll('{table}', place.table),
    params: [`composer:${body.client_id}`, body.text, JSON.stringify(came_from), media, body.at],
    statement_timeout_ms: seeds.statement_timeout_ms,
  }, `composer:${body.client_id}`);
  const row = ran.result?.rows?.[0];
  if (!row) throw new Error(seeds.not_kept);
  const time = new Date(row.kept_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return { message: seeds.sent_at.replace('{time}', time), message_id: row.id, kept_at: row.kept_at };
}
