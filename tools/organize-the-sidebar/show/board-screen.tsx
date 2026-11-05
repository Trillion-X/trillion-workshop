// parts/group/show/board-screen.tsx
//
// PURPOSE
//   The board: the group board ported from Bitfield (parts/group, GroupBoardPanel), composed over a space so every
//   member works on the same canvas at once. It is the screen of tool:screen-board
//   (records/workshop-screen-tool-records.json, the trillion.board screen), a screen module (scripts/screen-modules.mjs):
//   the workspace never carries this code, it imports it from its bundle when the board first opens
//   (src/workspace/tool-screen.tsx), and React, the shared parts and the workspace helpers it imports are the page's
//   own. It opens on a canvas tool chosen (`tool`, such as "draw"): a space's board when its input names `space_id`
//   (the Board place of a space that turned the board on, records/workshop-space-tool-records.json tool:space-board,
//   which space-kinds.json shows with this screen), else the person's own board (`board_id`, kept in their records).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A space's board records live in the space's live room (src/board-room.mjs), reached through the page's one
//      connection to it (src/workspace/live-room.ts), shared with every record placed in that space: the whole board
//      arrives when it opens, each change names the value it started from (so two members changing the board at once
//      both keep their change), and every other member's change arrives the moment it is kept. When the socket drops,
//      it opens again and the board is read whole again.
//   7. A note becomes a document in place (`toDocument`, offered by the board on a note): its words become the first
//      page of a document kept in the same store as the board (for a space board, the space's room through the label
//      record-places.json gives it; for the person's own board, their own records), and the card becomes that
//      document drawn live by Write (tool:screen-write, `scene_address`), so the board card and Write are one record
//      that every member sees change in both. The note's own words are taken off it: the document holds them.
//   2. A picture shared into the space appears on its board once, as an image card whose address is the picture's
//      lasting address in the space (/work/api/spaces/<id>/items/<item>/bytes), and a link shared into the space (an
//      item whose body is a web address, or carries one as `url`) appears once as a link card opening that address.
//      The board keeps what it has placed (PLACED: picture files by identity, links by address), so a card someone
//      deleted does not come back, and a picture dropped on the board (kept in the dropper's files, then shared into
//      the space) is placed once, as the card they dropped.
//   3. Cursors cross accounts through the space's board room (parts/group/show/presence-channel.ts), so a space's board
//      id is the space id.
//   4. Every action the board offers (board-screen.json `actions`) hands a job to the acting member's own AIs
//      (src/queued-work.json `board-*` rows) through Ask my AI (src/workspace/ask-my-ai.ts, the same owner Write's Ask AI
//      uses): Trillion runs no model here. What the AI makes comes back into the space and so onto the board.
//   5. Ink is kept where its board is kept: a space board's ink in the space (every member sees it), any other ink in
//      the person's own records (MARK_OPERATIONS_ADDRESS), kept by the marks keeper (parts/addressed-marks/show/keep-marks.ts).
//   6. Nothing here names a space, a company or a kind of work: the words of each action are DATA (board-screen.json).
//   7. A picture shared with a frame item (src/workspace/put-sizes-on-board.ts: where it was drawn from and its size) is
//      placed at its page's shape and keeps that frame, so Draw again draws it anew from the same address and the same
//      card shows the new picture (comments and votes stay on the card).
//   9. A board opened with a `surface` ({ screen, input, title }, a screen offered to this person) keeps that screen on
//      it as one live card, placed once the first time the board opens (its member id names the screen and its input,
//      so opening the same board again never places it twice, and a card someone moved or resized stays where they
//      left it). A workflow's Draw on it opens its own board this way: the workflow itself, live, with the board's
//      drawing, shapes, notes and pictures around it.
//  10. A board opened with a `source` ({ key, read, write? }: addresses on this page's own origin) draws the records the
//      `read` address answers (do-work/board-source.ts: cards with their words and live state, lines with what flows
//      along them) as cards and connectors, and reads it again whenever the person's store changes, so a record's
//      words and state follow it live while every card stays where the person put it. Words the person changes on a
//      source card are sent to `write` ({ edits: [{ id, text }] }); what an edit means for the record is the source's
//      to decide. An action a source card offers (try again, ask my AI), pressed, is sent to `act` ({ id, action }),
//      and the board reads the source again. A screen that already holds the records may hand them over instead of
//      addresses: `cards` and `lines` themselves, or `read` as a function, `write`/`act` as functions, and `changes`
//      (called with a notice, answering a stop) to have the board read it again when they change. A source that can
//      add records offers them from the board (`palette`, `add`): the person searches what it offers, picks one, and
//      the record the source added lands where they were looking. A source's board opens framing all its cards when
//      they run past the screen, never smaller than `source_layout.open_least_zoom` so their words stay readable.
//      The board names no kind of record: a workflow's steps are one source,
//      any list is another.
//   8. A note put into the space (kind `note_kind`, its words as body) is placed once as a note card. A thing carrying a
//      section (the item fact `section_fact`, any words; src/subject-boards.mjs sets it) joins one row per section that
//      starts with a card holding the section's name; a new section starts its row under everything on the board, and
//      the rows are kept in the space (SECTIONS) so later things join the same row; new rows come in the order the
//      things' `section_order_fact` gives. The board names no section.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { GroupBoardPanel } from './GroupBoardPanel.tsx';
import type { BoardFrameMedia } from '../do-work/board-frame-media.ts';
import { boardIndexRef, boardRootRef, itemRef, patchItems, placeItems, readBoards, readItems, removeItems, type PlaceItemArgs } from '../read-data/group-board-model.ts';
import { createGroupBoardStore } from '../read-data/read-group-board.ts';
import { foldGroupRecords } from '../read-data/group-eeaf.ts';
import { buildGroupWriteBatch } from '../do-work/group-mutation-writes.ts';
import type { GroupBoardStore } from '../read-data/read-group-board.ts';
import type { GroupGraph } from '../../ui/show/group/group-graph';
import { addInkPlace } from '../../addressed-marks/show/keep-marks';
import { boardWorldMarkTarget } from './BoardMarkLayers.tsx';
import { Container } from '../../ui/index.ts';
import { answerTarget, makeHashCodeHexFromBytes, readInputValue, readTrustedRuntimePartitionIfPresent, showRecords } from '#workspace-records';
import { onStoreChange } from '#workspace/store-changes.ts';
import { openLiveRoom, type LiveRoom } from '#workspace/live-room.ts';
import { offeredScreens, openScreenOn } from '#workspace/open-screen.ts';
import { buildEngineWriteBatchRequestFromLabels, placeOf, placedLabel, sendRequestToBitfieldTarget } from '#workspace-records';
import { sectionsToContent } from '../../documents';
import { LIVE_SURFACE_FOOTPRINT } from './placeable-surface-shelf.ts';
import type { BoardItem } from '../read-data/group-board-model.ts';
import { askMyAI } from '#workspace/ask-my-ai.ts';
import { planBoardSource, sourceEdits, sourceMarkOf, type BoardSource } from '../do-work/board-source.ts';
import settings from './board-screen.json';
import { uploadFiles } from '#workspace/upload.ts';
import { FRAME_KIND, drawFrame, frameOf, type Frame } from '#workspace/put-sizes-on-board.ts';
import { postJson, readJson } from '#workspace/api.ts';
import { publishMediaFiles } from '#workspace/media-publication.ts';

type BoardRecord = { address: string; value: unknown };
type SpaceItem = { item_id: string; kind: string; title: string | null; body: unknown; withdrawn?: unknown; facts?: Record<string, unknown> };
// A section's row on the board: where it sits, where its next card goes and how tall it is (invariant 8).
type SectionRow = { x: number; y: number; next: number; h: number };
type SpaceBoard = {
  spaceId: string;
  title: string;
  // The space's live room (invariant 1): what it holds is `room.known`.
  room: LiveRoom;
  release: () => void;
  reload: () => void;
};
// A space's records live in the place whose prefix board-screen.json names (src/workspace/record-places.json).
const spaceLabel = (spaceId: string, address: string) => placedLabel(settings.space_place, spaceId, address);
const spaceRoomPath = (spaceId: string) => {
  const placed = placeOf(spaceLabel(spaceId, PLACED));
  if (!placed) throw new Error(`No record place has the prefix ${settings.space_place}.`);
  return placed.path;
};

const GROUP_RECORD = 'package::group::group::';
const PLACED = 'space-board:placed-files';
const SECTIONS = 'space-board:section-rows';
const INK = 'space-board:ink:';
const MARK_OPERATIONS = 'mark-operations';
const MARK_OPERATIONS_ADDRESS = 'addressed-marks.operations';
const ACTIONS_ADDRESS = 'space-board-actions';
const CONTEXT_MAX = 300;
const PRESS_KEY_MAX = 100;

async function publishBoardFrames(boardId: string, frames: readonly BoardFrameMedia[]) {
  const publication = await publishMediaFiles(frames, {
    folder: `/Boards/${boardId.replace(/[^a-z0-9_-]/gi, '_')}/frames`,
    uploadFiles,
    makeShareLink: (record, input) => postJson<{ address: string; share_id: string }>(
      `/work/api/sharing/${encodeURIComponent(record)}/links`, input,
    ),
  });
  return {
    pageUrl: publication.pageUrl,
    mediaUrls: publication.mediaUrls,
    stop: () => postJson(
      `/work/api/sharing/${encodeURIComponent(publication.primaryRecord)}/links/${encodeURIComponent(publication.shareId)}/revoke`, {},
    ).then(() => {}),
  };
}

/**
 * Show a note as a document (invariant 7): the first time, its words become the first page of a document kept where
 * `labelOf` places it, and the answer is the patch that makes the card that document drawn live by the document
 * screen; every time, the document opens in its own tab. The document's address is the note's own, so the same note
 * always opens the same document.
 */
function openAsDocument(labelOf: (address: string) => string) {
  const doc = settings.as_document;
  return {
    label: doc.words.open,
    async run(item: BoardItem): Promise<Record<string, unknown> | null> {
      const shown = item.extra?.placeableSurface as { surfaceInput?: Record<string, unknown> } | undefined;
      const already = typeof shown?.surfaceInput?.scene_address === 'string' ? shown.surfaceInput.scene_address : null;
      const label = already ?? labelOf(`${doc.address_prefix}${item.memberId.replace(/[^0-9a-z_-]/gi, '')}`);
      const lines = (item.text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
      const title = lines[0] ?? doc.words.untitled;
      let patch: Record<string, unknown> | null = null;
      if (!already) {
        const screen = offeredScreens().find(one => one.id === doc.screen);
        if (!screen?.package_entry) throw new Error(doc.words.no_screen);
        const sections = lines.map((text, index) => (index === 0 && lines.length > 1 ? { text, heading: true, level: 1 } : { text }));
        const content = sectionsToContent(label, sections.length ? sections : [{ text: title }]);
        // `null` expected: a document already at this address is never replaced, only opened.
        await sendRequestToBitfieldTarget(buildEngineWriteBatchRequestFromLabels([{ addressLabel: label, pathLabels: doc.path, payload: content, expectedCurrent: { payloadHash: null } }]));
        patch = {
          text: '', html: '',
          w: Math.max(item.w, LIVE_SURFACE_FOOTPRINT.w), h: Math.max(item.h, LIVE_SURFACE_FOOTPRINT.h),
          placeableSurface: { packageName: screen.package_entry.package_name, entryName: screen.package_entry.entry_name, surfaceInput: { ...screen.surface_input, ...doc.card_input, scene_address: label } },
        };
      }
      openScreenOn(doc.screen, { scene_address: label }, title);
      return patch;
    },
  };
}

const at = (spaceId: string, rest = '') => `/work/api/spaces/${encodeURIComponent(spaceId)}${rest}`;
const bytesAddress = (spaceId: string, itemId: string) => `${location.origin}${at(spaceId, `/items/${encodeURIComponent(itemId)}/bytes`)}`;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clip = (words: string, most = CONTEXT_MAX) => (words.length > most ? `${words.slice(0, most - 1)}…` : words);
const isPicture = (body: unknown): body is { identity: string; media_type: string; name?: string } => isObject(body) && typeof body.identity === 'string' && typeof body.media_type === 'string' && body.media_type.startsWith('image/');
/** The web address a space item links to: its body itself, or the body's `url`; null for anything else. */
const linkOf = (body: unknown): string | null => {
  const address = typeof body === 'string' ? body.trim() : isObject(body) && typeof body.url === 'string' ? body.url.trim() : '';
  return /^https?:\/\/\S+$/i.test(address) ? address : null;
};
const targetOf = (row: unknown) => (isObject(row) && isObject(row.target) && typeof row.target.address === 'string' ? row.target.address : null);

async function boardRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const answer = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body = await answer.json().catch(() => null) as (T & { error?: string }) | null;
  if (!answer.ok || !body) throw new Error(body?.error ?? `The board could not be reached (${answer.status}). Try again.`);
  return body;
}

// The space boards open on this page, the one most recently touched first: a picture dropped there belongs to it.
const open: SpaceBoard[] = [];
// Every ink target a space board has shown on this page: that ink is the space's, never saved in the person's records.
const spaceInkTargets = new Set<string>();

const graphOf = (board: SpaceBoard): GroupGraph => foldGroupRecords([...board.room.known]
  .filter(([address]) => address.startsWith(GROUP_RECORD))
  .map(([address, value]) => ({ address, value_json: value })));
const rowsOf = (board: SpaceBoard): Record<string, SectionRow> => {
  const rows = board.room.known.get(SECTIONS);
  return isObject(rows) ? rows as Record<string, SectionRow> : {};
};
const placedOf = (board: SpaceBoard): string[] => {
  const placed = board.room.known.get(PLACED);
  return Array.isArray(placed) ? placed.filter((one): one is string => typeof one === 'string') : [];
};
/** The ink targets of a space board: its own board and every board its index holds. */
const inkTargetsOf = (board: SpaceBoard) => [board.spaceId, ...readBoards(graphOf(board), boardIndexRef(board.spaceId)).map(entry => entry.boardId)]
  .map(boardId => boardWorldMarkTarget(boardId).address);

/** Send board changes to the room; true when the room merged in someone else's change, so the board reads again. */
const change = (board: SpaceBoard, changes: BoardRecord[]): Promise<boolean> => board.room.change(changes);

/** Show a space board's ink beside the rest of the page's ink. */
function showInk(board: SpaceBoard) {
  const targets = new Set(inkTargetsOf(board));
  for (const target of targets) spaceInkTargets.add(target);
  const current = readInputValue<unknown>(MARK_OPERATIONS);
  const others = (Array.isArray(current) ? current : []).filter(row => !targets.has(targetOf(row) ?? ''));
  const ink = [...board.room.known].filter(([address]) => address.startsWith(INK)).map(([, value]) => value);
  showRecords({ [MARK_OPERATIONS_ADDRESS]: [...others, ...ink] });
}

// ---- Ink drawn on a space board is kept in the space (invariant 5); the marks keeper keeps all other ink ----
addInkPlace({
  holds: target => open.some(one => inkTargetsOf(one).includes(target)),
  shows: target => spaceInkTargets.has(target),
  keep: async row => {
    const target = targetOf(row) ?? '';
    const board = open.find(one => inkTargetsOf(one).includes(target));
    if (!board) throw new Error(settings.words.board_closed);
    await change(board, [{ address: `${INK}${String(row.id)}`, value: row }]);
    showInk(board);
  },
});

// ---- A board action: a job for the acting member's own AIs (invariant 4) ----
const boardOfAction = (payload: unknown): SpaceBoard | null => {
  if (!isObject(payload) || typeof payload.definition_id !== 'string' || !payload.definition_id.startsWith(settings.definition_prefix)) return null;
  const input = isObject(payload.input) ? payload.input : {};
  return open.find(board => board.spaceId === input.space_id) ?? null;
};
answerTarget('slot::workflow', async payload => {
  const board = boardOfAction(payload);
  if (!board || !isObject(payload)) throw new Error(settings.words.board_closed);
  const input = isObject(payload.input) ? payload.input : {};
  const cards = readItems(graphOf(board), boardRootRef(board.spaceId));
  const chosen = Array.isArray(input.member_ids) && input.member_ids.length ? cards.filter(card => (input.member_ids as unknown[]).includes(card.memberId)) : cards;
  const items = chosen.map(card => {
    const shared = typeof card.src === 'string' ? /\/items\/([^/]+)\/bytes$/.exec(card.src)?.[1] : undefined;
    if (shared) return `${settings.words.picture} ${decodeURIComponent(shared)}`;
    if (card.kind === settings.link_kind && typeof card.src === 'string') return `${settings.words.link} ${card.src}`;
    return `"${(card.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}"`;
  }).join('; ') || settings.words.empty_board;
  const what = typeof input.what === 'string' && input.what.trim() ? input.what.trim() : settings.words.no_words;
  // The board's AI puts what it makes into the space itself, so it shows on the board: the job is handed, not waited on.
  return askMyAI({
    job_id: String(payload.definition_id).slice(settings.definition_prefix.length),
    context: { space_id: board.spaceId, space_title: clip(board.title), what: clip(what), items: clip(items) },
    press_key: clip(`board:${board.spaceId}:${String(input.request_id ?? Date.now())}`, PRESS_KEY_MAX),
  }, { wait: false });
}, { handles: payload => boardOfAction(payload) !== null });

// ---- Draw again: each chosen frame is drawn from where it came from, and its card shows the new picture ----
const boardOfFrameAction = (payload: unknown): SpaceBoard | null => {
  if (!isObject(payload) || typeof payload.definition_id !== 'string' || !payload.definition_id.startsWith(settings.frame.definition_prefix)) return null;
  const input = isObject(payload.input) ? payload.input : {};
  return open.find(board => board.spaceId === input.space_id) ?? null;
};
answerTarget('slot::workflow', async payload => {
  const board = boardOfFrameAction(payload);
  if (!board || !isObject(payload)) throw new Error(settings.words.board_closed);
  const input = isObject(payload.input) ? payload.input : {};
  const root = boardRootRef(board.spaceId);
  const chosen = Array.isArray(input.member_ids) ? input.member_ids : [];
  const cards = readItems(graphOf(board), root).filter(card => chosen.includes(card.memberId) && frameOf(card.extra.frame));
  if (!cards.length) throw new Error(settings.frame.words.none_chosen);
  const folder = `${settings.folder}/${board.title.replace(/[\\/]/g, ' ').trim() || board.spaceId}`;
  const drawn: { memberId: string; frame: Frame; item_id: string }[] = [];
  for (const card of cards) {
    const was = frameOf(card.extra.frame) as Frame;
    // Placed before it is shared, so the board does not place the new picture as a second card.
    const again = await drawFrame({ spaceId: board.spaceId, folder, title: card.text ?? settings.frame.words.frame, draw: was.draw, width: was.width,
      beforeShare: identity => change(board, [{ address: PLACED, value: [...placedOf(board), identity] }]).then(() => {}) });
    drawn.push({ memberId: card.memberId, ...again });
  }
  const before = graphOf(board);
  const after = patchItems(before, root, drawn.map(({ memberId, frame, item_id }) => ({ memberId, patch: { src: bytesAddress(board.spaceId, item_id), frame } })));
  const writes = buildGroupWriteBatch(before, after).payload.writes.map(write => ({ address: write.address_label, value: write.payload as unknown }));
  if (await change(board, writes)) board.reload();
  return { drawn: drawn.length };
}, { handles: payload => boardOfFrameAction(payload) !== null });

// ---- A picture dropped or pasted on a space board (invariant 2) ----
answerTarget('content-media-evidence.materialize-artifact', async payload => {
  const board = open[0];
  const source = isObject(payload) && isObject(payload.source) ? payload.source : null;
  if (!board || !source || !Array.isArray(source.bytes) || typeof source.media_type !== 'string') throw new Error(settings.words.unreadable_picture);
  const bytes = Uint8Array.from(source.bytes as number[]);
  const name = typeof source.display_name === 'string' && source.display_name ? source.display_name : settings.words.dropped_name;
  const [kept] = await uploadFiles([new File([bytes], name, { type: source.media_type, lastModified: Date.now() })], `${settings.folder}/${board.title.replace(/[\\/]/g, ' ').trim() || board.spaceId}`);
  if (!kept) throw new Error(settings.words.unreadable_picture);
  await change(board, [{ address: PLACED, value: [...placedOf(board), kept.identity] }]);
  const shared = await boardRequest<{ item_id: string }>(at(board.spaceId, '/share'), { method: 'POST', body: JSON.stringify({ file: kept.identity }) });
  return {
    kind: 'content-media.materialized-relation/v1',
    relation_ref: bytesAddress(board.spaceId, shared.item_id),
    media_type: source.media_type.toLowerCase(),
    display_name: name,
    byte_length: bytes.byteLength,
    integrity_hash: makeHashCodeHexFromBytes(bytes),
  };
}, { handles: payload => open.length > 0 && isObject(payload) && isObject(payload.relation) && isObject(payload.relation.role_ref) && payload.relation.role_ref.id === settings.artifact_role });

/** Follow the board's room: every record it sends shows the board's ink and reads the board again (once per moment). */
function followRoom(board: SpaceBoard): () => void {
  let reread: ReturnType<typeof setTimeout> | null = null;
  const stop = board.room.listen(() => {
    showInk(board);
    if (!reread) reread = setTimeout(() => { reread = null; board.reload(); }, settings.reread_after_ms);
  });
  if (board.room.known.size) showInk(board);
  return () => { stop(); if (reread) clearTimeout(reread); };
}

/** Every picture, link and note in the space the board has not placed yet becomes a card (invariant 2). A thing with a
 *  section (the item fact `section_fact`) joins its section's row, which starts with the section's name; a new section
 *  starts a row under everything on the board (invariant 8). A thing with no section is placed beside what is there. */
async function placeNewItems(board: SpaceBoard) {
  const { items } = await boardRequest<{ items: SpaceItem[] }>(at(board.spaceId, `/items?limit=${settings.items_read}`));
  const placed = new Set(placedOf(board));
  // A picture put here as a frame (src/workspace/put-sizes-on-board.ts) is placed at its page's shape and keeps where
  // it was drawn from, so it can be drawn again.
  const frames = new Map(items.flatMap(item => {
    const frame = !item.withdrawn && item.kind === FRAME_KIND ? frameOf(item.body) : null;
    return frame ? [[frame.picture, frame] as const] : [];
  }));
  const sectionOf = (item: SpaceItem) => (typeof item.facts?.[settings.section_fact] === 'string' ? String(item.facts[settings.section_fact]).trim() : '');
  const fresh = items.flatMap(item => {
    if (item.withdrawn) return [];
    const section = sectionOf(item);
    if (isPicture(item.body)) return placed.has(item.body.identity) ? [] : [{ item, key: item.body.identity, link: null, note: null, section }];
    if (item.kind === settings.note_kind && typeof item.body === 'string' && item.body.trim()) {
      const key = `${settings.note_kind}:${item.item_id}`;
      return placed.has(key) ? [] : [{ item, key, link: null, note: item.body.trim(), section }];
    }
    const link = linkOf(item.body);
    return link && !placed.has(link) ? [{ item, key: link, link, note: null, section }] : [];
  }).reverse();
  // Things that say their section's place come in that order (a stable sort keeps the rest as they arrived).
  const orderOf = (item: SpaceItem) => (typeof item.facts?.[settings.section_order_fact] === 'number' ? Number(item.facts[settings.section_order_fact]) : Infinity);
  fresh.sort((a, b) => (orderOf(a.item) - orderOf(b.item)) || 0);
  if (!fresh.length) return false;
  const before = graphOf(board);
  const root = boardRootRef(board.spaceId);
  const cards = readItems(before, root);
  const { card_width: w, card_height: h, link_card_height: linkHeight, note_card_height: noteHeight, heading_card_height: headingHeight, card_gap: gap, cards_per_row: perRow } = settings;
  const rows = { ...rowsOf(board) };
  // The bottom of the board, kept as rows are added in this pass so two new sections never overlap.
  let bottom = Math.max(cards.reduce((low, card) => Math.max(low, card.y + card.h), 0), ...Object.values(rows).map(row => row.y + row.h));
  const leftmost = cards.length ? cards.reduce((least, card) => Math.min(least, card.x), Infinity) : 0;
  const left = cards.length ? cards.reduce((right, card) => Math.max(right, card.x + card.w), -Infinity) + gap : 0;
  const top = cards.length ? cards.reduce((least, card) => Math.min(least, card.y), Infinity) : 0;
  let loose = 0;
  const args: PlaceItemArgs[] = [];
  const cardOf = ({ item, key, link, note }: typeof fresh[number]) => {
    const id = `space-${link ? 'link' : note ? 'note' : 'file'}-${(link || note ? item.item_id : key).replace(/[^0-9a-z]/gi, '').slice(-24)}`;
    const shape = { memberId: id, nodeRef: itemRef(board.spaceId, id), w };
    if (note) return { ...shape, kind: settings.note_kind, h: noteHeight, text: item.title ? `${item.title}\n${note}` : note };
    if (link) {
      const body = isObject(item.body) ? item.body : {};
      const image = typeof body.picture === 'string' && /^https:\/\//.test(body.picture) ? body.picture : undefined;
      const preview = item.title || image ? { linkPreview: { ...(item.title ? { title: item.title } : {}), ...(image ? { image } : {}) } } : undefined;
      return { ...shape, kind: settings.link_kind, h: image ? h : linkHeight, text: item.title ?? link, src: link, extra: preview };
    }
    const picture = item.body as { name?: string };
    const frame = frames.get(key);
    const size = frame ? { h: Math.round(w * Math.min(frame.height / frame.width, settings.frame.tallest)), extra: { frame } } : { h };
    return { ...shape, kind: settings.picture_kind, ...size, text: item.title ?? picture.name?.split('/').pop() ?? '', src: bytesAddress(board.spaceId, item.item_id) };
  };
  for (const one of fresh) {
    const card = cardOf(one);
    if (!one.section) {
      args.push({ ...card, x: left + (loose % perRow) * (w + gap), y: top + Math.floor(loose / perRow) * (h + gap) });
      loose += 1;
      continue;
    }
    let row = rows[one.section];
    if (!row) {
      const y = bottom ? bottom + gap * 2 : 0;
      const heading = `space-section-${one.section.toLowerCase().replace(/[^0-9a-z]+/g, '-').slice(0, 40)}-${Object.keys(rows).length}`;
      args.push({ memberId: heading, nodeRef: itemRef(board.spaceId, heading), kind: settings.note_kind, x: leftmost, y, w, h: headingHeight, text: one.section });
      row = { x: leftmost, y, next: leftmost + w + gap, h: headingHeight };
    }
    args.push({ ...card, x: row.next, y: row.y });
    row = { ...row, next: row.next + w + gap, h: Math.max(row.h, card.h) };
    rows[one.section] = row;
    bottom = Math.max(bottom, row.y + row.h);
  }
  const writes = buildGroupWriteBatch(before, placeItems(before, root, args)).payload.writes.map(write => ({ address: write.address_label, value: write.payload as unknown }));
  await change(board, [...writes, { address: PLACED, value: [...placed, ...fresh.map(one => one.key)] }, { address: SECTIONS, value: rows }]);
  return true;
}

/** One space's board, shared by every member of the space. */
function SpaceBoard({ spaceId, title, tool }: { spaceId: string; title: string; tool?: string }) {
  const [reloadSignal, setReloadSignal] = React.useState(0);
  const board = React.useMemo<SpaceBoard>(() => {
    const { room, release } = openLiveRoom(spaceRoomPath(spaceId));
    return { spaceId, title, room, release, reload: () => setReloadSignal(count => count + 1) };
  }, [spaceId, title]);
  const host = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    open.unshift(board);
    const closeRecords = followRoom(board);
    showRecords({ [ACTIONS_ADDRESS]: [...settings.actions, ...settings.action_catalog].map(payload => ({ address: `${ACTIONS_ADDRESS}:${payload.id}`, payload })) });
    let active = true;
    let placing: Promise<void> | null = null;
    let readAgain = false;
    const syncItems = () => {
      if (placing) { readAgain = true; return; }
      placing = placeNewItems(board)
        .then(added => { if (added && active) board.reload(); })
        .catch(error => console.error('[space-board] the space pictures and links could not be placed', error))
        .finally(() => {
          placing = null;
          if (readAgain && active) { readAgain = false; syncItems(); }
        });
    };
    // Space files arrive independently of the board-room records. A slow item list must not hold the canvas open.
    void board.room.opened().then(() => { if (active) syncItems(); });
    let queued: ReturnType<typeof setTimeout> | null = null;
    // Something new in the space (a picture shared there) is placed on the board, once per moment however many arrive.
    const stop = onStoreChange(() => {
      if (queued) return;
      queued = setTimeout(() => {
        queued = null;
        syncItems();
      }, settings.reread_after_ms);
    });
    const element = host.current;
    const touch = () => { open.splice(open.indexOf(board), 1); open.unshift(board); };
    element?.addEventListener('pointerdown', touch, true);
    return () => {
      active = false;
      closeRecords();
      board.release();
      stop();
      if (queued) clearTimeout(queued);
      element?.removeEventListener('pointerdown', touch, true);
      open.splice(open.indexOf(board), 1);
    };
  }, [board]);

  const makeStore = React.useCallback((): GroupBoardStore => ({
    load: async () => {
      await board.room.opened();
      return graphOf(board);
    },
    apply: async (before, after) => {
      const writes = buildGroupWriteBatch(before, after).payload.writes.map(write => ({ address: write.address_label, value: write.payload as unknown }));
      if (await change(board, writes)) board.reload();
    },
  }), [board]);

  const asDocument = React.useMemo(() => openAsDocument(address => spaceLabel(spaceId, address)), [spaceId]);
  const readResponseSummaries = React.useCallback(async () => {
    const all: Array<{ record: string; count: number; last_at: string | null; resolved: boolean }> = [];
    let after: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '100' });
      if (after) query.set('after', after);
      const page = await readJson<{ summaries: typeof all; next_after: string | null }>(`${at(spaceId, '/responses/summaries')}?${query}`);
      all.push(...page.summaries);
      after = page.next_after;
    } while (after);
    return all.flatMap(row => {
      const lastAt = row.last_at ? Date.parse(row.last_at) : 0;
      return typeof row.record === 'string' && Number.isFinite(lastAt)
        ? [{ record: row.record, count: row.count, lastAt, resolved: row.resolved }]
        : [];
    });
  }, [spaceId]);
  const readResponseThread = React.useCallback(async (record: string) => {
    const entries: Array<{ id: string; author: string; text: string; at: number; record: string; resolved: boolean }> = [];
    let before: string | null = null;
    let resolved = false;
    do {
      const query = new URLSearchParams({ record, limit: '100' });
      if (before) query.set('before', before);
      const page = await readJson<{ items: Array<{ item_id: string; body: unknown; provenance: { by: string; added_at: string } }>; resolved: boolean; next_after: string | null }>(`${at(spaceId, '/responses')}?${query}`);
      resolved = page.resolved;
      for (const item of page.items) {
        const body = item.body && typeof item.body === 'object' ? item.body as { text?: unknown } : null;
        const atMs = Date.parse(item.provenance.added_at);
        if (typeof body?.text === 'string' && Number.isFinite(atMs)) entries.push({ id: item.item_id, author: item.provenance.by, text: body.text, at: atMs, record, resolved });
      }
      before = page.next_after;
    } while (before);
    return { entries, resolved };
  }, [spaceId]);
  const addResponse = React.useCallback((record: string, text: string) => postJson(at(spaceId, '/items'), { items: [{ kind: 'message', body: { text }, anchor: { record } }] }), [spaceId]);
  const setResponseResolved = React.useCallback((record: string, resolved: boolean) => postJson(at(spaceId, '/responses/resolve'), { record, resolved }), [spaceId]);

  return (
    <Container ref={host} layout="vertical" flex="1" minHeight="0" data-space-board={spaceId} data-response-space={spaceId} data-response-audience={`Everyone in ${title}`}>
      <GroupBoardPanel partitionLabel={readTrustedRuntimePartitionIfPresent()} boardId={spaceId} title={title} makeStore={makeStore} sharedRoom responseSpaceId={spaceId} readResponseSummaries={readResponseSummaries} readResponseThread={readResponseThread} addResponse={addResponse} setResponseResolved={setResponseResolved} reloadSignal={reloadSignal} openAsDocument={asDocument} publishFrameMedia={frames => publishBoardFrames(spaceId, frames)} {...(tool ? { initialToolId: tool } : {})} />
    </Container>
  );
}


type KeptSurface = { screen: string; input: Record<string, unknown>; title?: string };
const keptSurfaceOf = (value: unknown): KeptSurface | null => (isObject(value) && typeof value.screen === 'string' && value.screen
  ? { screen: value.screen, input: isObject(value.input) ? value.input : {}, ...(typeof value.title === 'string' ? { title: value.title } : {}) } : null);

/** A board store that keeps one screen on the board as a live card (invariant 9): placed the first time the board is
 *  read without it, then left wherever the person puts it. */
function keepingSurface(store: GroupBoardStore, boardId: string, surface: KeptSurface): GroupBoardStore {
  const memberId = `surface-${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify([surface.screen, surface.input]))).slice(3, 19)}`;
  return {
    load: async roots => {
      const graph = await store.load(roots);
      const root = boardRootRef(boardId);
      if (readItems(graph, root).some(item => item.memberId === memberId)) return graph;
      const screen = offeredScreens().find(one => one.id === surface.screen);
      if (!screen?.package_entry) return graph;
      const size = settings.kept_surface;
      const after = placeItems(graph, root, [{
        memberId, nodeRef: itemRef(boardId, memberId), kind: settings.note_kind, x: size.x, y: size.y, w: size.w, h: size.h,
        extra: { placeableSurface: { packageName: screen.package_entry.package_name, entryName: screen.package_entry.entry_name, surfaceInput: { ...screen.surface_input, ...surface.input } } },
      }]);
      await store.apply(graph, after);
      return after;
    },
    apply: (before, after) => store.apply(before, after),
  };
}

/** Where a source's records come from and where the person's changes go: an address on this page's own origin, or,
 *  for a screen that already holds the records (a list opened as a board), the records themselves and what to call. */
type SourceRead = string | (() => BoardSource | null | Promise<BoardSource | null>);
type SourceSend = string | ((body: Record<string, unknown>) => unknown);
type SourcePalette = string | ((words: string) => SourceRow[] | Promise<SourceRow[]>);
type SourceRow = { id: string; label: string; icon?: string; detail?: string; section?: string };
type FollowedSource = {
  key: string; read: SourceRead; write?: SourceSend; act?: SourceSend; changes?: (notify: () => void) => () => void;
  /** What the source can add from the board: the rows to choose from (an address answering `{ rows }` for `?q=<words>`,
   *  or a function of the words), `add` (sent `{ kind, at, words? }`, answering `{ id }` of the record it added), and the
   *  button's words. */
  palette?: SourcePalette; add?: SourceSend; add_label?: string; add_placeholder?: string;
};
const ownAddress = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
const sendOf = (value: unknown): SourceSend | null => (ownAddress(value) || typeof value === 'function' ? value as SourceSend : null);
const followedSourceOf = (value: unknown): FollowedSource | null => {
  if (!isObject(value) || typeof value.key !== 'string' || !value.key) return null;
  const key = value.key;
  const inline = Array.isArray(value.cards) ? { key, cards: value.cards as BoardSource['cards'], lines: (Array.isArray(value.lines) ? value.lines : []) as BoardSource['lines'] } : null;
  const read: SourceRead | null = ownAddress(value.read) || typeof value.read === 'function' ? value.read as SourceRead : inline ? () => inline : null;
  if (!read) return null;
  const write = sendOf(value.write), act = sendOf(value.act);
  const add = sendOf(value.add);
  const palette = ownAddress(value.palette) || typeof value.palette === 'function' ? value.palette as SourcePalette : null;
  return {
    key, read, ...(write ? { write } : {}), ...(act ? { act } : {}), ...(typeof value.changes === 'function' ? { changes: value.changes as FollowedSource['changes'] } : {}),
    ...(palette && add ? { palette, add, add_label: typeof value.add_label === 'string' && value.add_label ? value.add_label : settings.words.add_from_source, ...(typeof value.add_placeholder === 'string' ? { add_placeholder: value.add_placeholder } : {}) } : {}),
  };
};
const readSource = (read: SourceRead) => (typeof read === 'string' ? readJson<BoardSource>(read) : Promise.resolve(read()));
const sendSource = (send: SourceSend, body: Record<string, unknown>) => (typeof send === 'string' ? postJson(send, body) : Promise.resolve(send(body)));

/** A board store that keeps a source's records drawn on the board (invariant 10): every read of the board reads the
 *  source too and keeps only what changed, and words changed on a source card go back to the source. */
function followingSource(store: GroupBoardStore, boardId: string, source: FollowedSource, placed: Map<string, { x: number; y: number }>): GroupBoardStore {
  const root = boardRootRef(boardId);
  return {
    load: async roots => {
      const [graph, drawn] = await Promise.all([store.load(roots), readSource(source.read).catch(() => null)]);
      if (!drawn || drawn.key !== source.key) return graph;
      const plan = planBoardSource(readItems(graph, root), drawn, boardId, settings.source_layout, placed);
      // A record placed where the person asked for it has landed; from now on where it sits is theirs.
      for (const id of [...placed.keys()]) if (drawn.cards.some(card => card.id === id)) placed.delete(id);
      if (!plan.place.length && !plan.patch.length && !plan.remove.length) return graph;
      const after = removeItems(patchItems(placeItems(graph, root, plan.place), root, plan.patch), root, plan.remove);
      await store.apply(graph, after);
      return after;
    },
    apply: async (before, after) => {
      await store.apply(before, after);
      if (!source.write) return;
      const edits = sourceEdits(readItems(before, root), readItems(after, root), source.key);
      if (edits.length) await sendSource(source.write, { edits }).catch(() => undefined);
    },
  };
}

/** Reads the board again whenever the person's store changes (a run moving on, a record edited elsewhere), at most
 *  once per `reread_after_ms`, so a source's cards follow their records. */
function useStoreChangeSignal(enabled: boolean): number | undefined {
  const [signal, setSignal] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = onStoreChange(() => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; setSignal(value => value + 1); }, settings.source_layout.reread_after_ms);
    });
    return () => { stop(); if (timer) clearTimeout(timer); };
  }, [enabled]);
  return enabled ? signal : undefined;
}

function OwnBoard({ boardId, title, tool, surface, source }: { boardId: string; title: string; tool?: string; surface: KeptSurface | null; source: FollowedSource | null }) {
  const placed = React.useRef(new Map<string, { x: number; y: number }>());
  const makeStore = React.useMemo(() => (surface || source
    ? (partition: string, rootRef: Parameters<typeof createGroupBoardStore>[1]) => {
      let store = createGroupBoardStore(partition, rootRef);
      if (surface) store = keepingSurface(store, boardId, surface);
      if (source) store = followingSource(store, boardId, source, placed.current);
      return store;
    }
    : undefined), [boardId, surface, source]);
  const [pressed, setPressed] = React.useState(0);
  // A source that says when its records change (a list held by its own screen) is read again then, too.
  React.useEffect(() => source?.changes?.(() => setPressed(value => value + 1)), [source]);
  const changed = useStoreChangeSignal(Boolean(source));
  const reloadSignal = changed === undefined ? undefined : changed + pressed;
  const onSourceAction = React.useCallback((item: BoardItem, action: string) => {
    const id = sourceMarkOf(item)?.id;
    if (!source?.act || !id) return;
    void sendSource(source.act, { id, action }).catch(() => undefined).then(() => setPressed(value => value + 1));
  }, [source]);
  const sourceAdds = React.useMemo(() => {
    const palette = source?.palette;
    const add = source?.add;
    if (!palette || !add) return undefined;
    return {
      label: source.add_label ?? settings.words.add_from_source,
      ...(source.add_placeholder ? { placeholder: source.add_placeholder } : {}),
      search: (words: string) => (typeof palette === 'string'
        ? readJson<{ rows: SourceRow[] }>(`${palette}${palette.includes('?') ? '&' : '?'}q=${encodeURIComponent(words)}`).then(answer => answer.rows ?? [])
        : Promise.resolve(palette(words))),
      add: (kind: string, at: { x: number; y: number }, words: string) => {
        void Promise.resolve(sendSource(add, { kind, at, ...(words.trim() ? { words: words.trim() } : {}) })).then(answer => {
          const id = isObject(answer) && typeof answer.id === 'string' ? answer.id : null;
          if (id) placed.current.set(id, at);
        }, () => undefined).then(() => setPressed(value => value + 1));
      },
    };
  }, [source]);
  return (
    <Container layout="vertical" flex="1" minHeight="0">
      <GroupBoardPanel partitionLabel={readTrustedRuntimePartitionIfPresent()} boardId={boardId} title={title} {...(makeStore ? { makeStore } : {})} {...(reloadSignal !== undefined ? { reloadSignal } : {})} {...(source?.act ? { onSourceAction } : {})} {...(sourceAdds ? { sourceAdds } : {})} fitOnOpen={source ? { leastZoom: settings.source_layout.open_least_zoom } : null} openAsDocument={openAsDocument(address => address)} publishFrameMedia={frames => publishBoardFrames(boardId, frames)} {...(tool ? { initialToolId: tool } : {})} />
    </Container>
  );
}

/** The screen (a screen module's one export, `mount`): a space's board (`space_id`) or the person's own board
 *  (`board_id`), opened on the tool its input names (`tool`). */
export function mount(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const input = props.surfaceInput ?? {};
  const tool = typeof input.tool === 'string' ? input.tool : undefined;
  const spaceId = typeof input.space_id === 'string' ? input.space_id : '';
  const root = createRoot(element);
  let stopped = false;
  if (spaceId) {
    void boardRequest<{ title: string }>(at(spaceId)).then(space => space.title, () => '').then(title => {
      if (!stopped) root.render(<SpaceBoard spaceId={spaceId} title={title} {...(tool ? { tool } : {})} />);
    });
  } else {
    const boardId = typeof input.board_id === 'string' && input.board_id ? input.board_id : settings.own_board.id;
    const surface = keptSurfaceOf(input.surface);
    const source = followedSourceOf(input.source);
    const title = typeof input.title === 'string' && input.title ? input.title : surface?.title ?? settings.own_board.title;
    root.render(<OwnBoard boardId={boardId} title={title} surface={surface} source={source} {...(tool ? { tool } : {})} />);
  }
  return () => { stopped = true; root.unmount(); };
}
