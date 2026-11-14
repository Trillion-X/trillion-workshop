// src/workspace/menu-rows.tsx
//
// PURPOSE
//   The page's one source of what every ⋯ menu offers for the thing it is about (installed into the shared ActionMenu
//   by installMenuRows, parts/ui/show/action-menu/menu-rows.ts). A menu says what it is about (a file, a screen, a list
//   row: its kind, id, title, the facts it has and how it is sent, `share`); this lists every row that applies, from
//   the sources menu-rows.json names, in its order:
//     - tools: every Workshop tool this person can run on it and every screen that opens on it (GET
//       /work/api/workshop/for-thing, src/work-workshop.mjs thingActions): for a file, what takes a file of its kind;
//       for anything, a tool whose required inputs are all formats the thing carries (its own id as
//       `trillion:<kind>`, menu-rows.json `carries`), nested by the folder each tool sits in, named by the sidebar list
//       that holds that folder (surfaces.json sidebar_collections);
//     - saved actions: the person's own "Your AI will" list in its folders (GET /work/api/share-destinations), each
//       sending the thing to their AI with that action, after a Write to your AI row that opens the shared message box
//       inside the menu (words, voice, camera, screen recording, files) and sends the thing with what was written;
//     - formats: the person's formats by category (GET /work/api/content-formats), each asking their AI to make the
//       thing into that format;
//     - sharing: one Share row opening the one sharing sheet for what the thing names (a record, a file, a part of a
//       record, a space), so every ⋯ in Trillion shares the same way (src/workspace/sharing-sheet.tsx);
//     - versions: when the person's store kept the thing as two versions (two devices changed it apart), one row that
//       opens the view settling it inside the menu (src/workspace/catch-up.tsx versionsRows).
//   Every row is shown or hidden by the person's show rules (showOf, subject `menu-row`), so which rows a file type, a
//   time of day, a device or a test group sees is a rule, never code.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No row is named here: a tool, a saved action or a format added anywhere appears in every menu it applies to.
//   2. Every send goes through the one delivery road (POST /work/api/share-destinations/deliver) to the person's own
//      AI, which does the work on the AI the person already uses; nothing here asks a model.
//   3. Each list is read once per page (tools once per kind of thing), only when a menu first opens, and kept: drawing a
//      menu writes nothing and reads nothing the page already holds.
//   4. A run is the same run a tool's own screen starts (workshop-tool-api.ts, POST /work/api/door/tools:run), under a
//      fresh key.
//   5. Words are DATA (menu-rows.json).

import React from 'react';
import { lazyPart } from '../../parts/ui/show/load-later/later';
import type { ComposerDraft } from '../../parts/ui/show/composer';
import { provideMenuRows, announceMenuRows, type MenuThing } from '../../parts/ui/show/action-menu';
import type { ActionMenuItem } from '../../parts/ui/show/action-menu';
import { onShowChange, showOf } from '../../parts/ui/show/show-rules/show-of';
import { actionTree } from '../action-folders.mjs';
import { accountBucket, postJson, readJson } from './api';
import { newRunKey, runWorkshopTool } from './workshop-tool-api';
import { offeredScreens, openScreenOn } from './open-screen';
import { actionPicker, type Action, type Folder } from './action-picker';
import { onCatchUpChange } from '../../parts/ui/show/catch-up';
import { versionsRows } from 'trillion-workshop/tools/keep-copies-in-step/web/src/workspace/catch-up.tsx';
import surfaces from './surfaces.json';
import data from './menu-rows.json';

/** One item the delivery road takes (src/share-destinations.mjs deliver): a file, a record, a link or words. */
export type ShareItem = { kind: string; [field: string]: unknown };
/** What a menu is about, as this source reads it. */
export type Thing = MenuThing & { media_type?: string; name?: string; share?: ShareItem };

/** What the Workshop offers for a thing (src/work-workshop.mjs thingActions): a run fills each input (`fills`, input
 *  name to format) from what the thing carries; an open opens a screen on a file. */
export type Offered = { id: string; label: string; icon: string; about?: string; group?: string; kind: 'run' | 'open'; fills?: Record<string, string>; surface?: string; input?: Record<string, unknown> };
/** The values a thing carries by the input format they fill. */
export type Carried = Record<string, string>;
type Format = { id: string; label: string; icon?: string; category?: string; category_id?: string; category_icon?: string };
type Saved = { actions: Action[]; folders?: Folder[] };
type Node = { action: Action } | { folder: Folder; rows: Node[] };
type Delivered = { delivered: { id: string; label: string }[]; stopped_at: { label: string; error: string } | null };
export type Row = ActionMenuItem & { run?: (thing: Thing) => Promise<string> };

const SUBJECT = 'menu-row';
// The format a file's own id fills (a tool input that takes a file, src/workshop.mjs).
const FILE_FORMAT = 'namespace-file';
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole);
const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/';

// Each list read once per page, only when first asked for; a failed read is asked again next time.
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let kept: Promise<T> | null = null;
  return () => (kept ??= read().catch(error => { kept = null; throw error; }));
}
/** What a thing carries, by format (menu-rows.json `carries`): each row whose `kinds` hold the thing's kind (or every
 *  kind, when it names none) carries the thing's own id under its format, `{kind}` standing for the thing's kind. */
export function carriedOf(thing: { kind: string; id: string }): Carried {
  return Object.fromEntries(data.carries.filter(row => !row.kinds?.length || row.kinds.includes(thing.kind)).map(row => [fill(row.format, { kind: thing.kind }), thing.id]));
}
const toolsByKind = new Map<string, Promise<Offered[]>>();
/** What the Workshop offers for a thing that carries these formats (and, for a file, has this media type or name),
 *  read once per kind of thing. */
export function offeredFor(carried: Carried, file?: { type: string; name: string }): Promise<Offered[]> {
  const formats = Object.keys(carried).sort().join(',');
  const key = `${file ? file.type || file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : ''}|${formats}`;
  if (!toolsByKind.has(key)) {
    const asked = readJson<{ actions: Offered[] }>(`/work/api/workshop/for-thing?type=${encodeURIComponent(file?.type ?? '')}&name=${encodeURIComponent(file?.name ?? '')}&carries=${encodeURIComponent(formats)}`).then(answer => answer.actions);
    asked.catch(() => toolsByKind.delete(key));
    toolsByKind.set(key, asked);
  }
  return toolsByKind.get(key)!;
}
const savedActions = once(() => readJson<Saved>('/work/api/share-destinations'));
const formats = once(() => readJson<{ formats: Format[] }>('/work/api/content-formats').then(answer => answer.formats));

/** A thing's own values for an action's input: `{ from: "file", field }` becomes a file's identity, name, type, folder
 *  or address, and `{ from: "thing", field }` any other thing's id, kind or address (`<kind>:<id>`). */
export function filled(template: unknown, values: Record<string, string>, from = 'file'): unknown {
  if (Array.isArray(template)) return template.map(item => filled(item, values, from));
  if (template && typeof template === 'object') {
    const value = template as Record<string, unknown>;
    if (value.from === from && typeof value.field === 'string') return values[value.field] ?? '';
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filled(item, values, from)]));
  }
  return template;
}

const ranListeners = new Set<() => void>();
/** Hears every tool run from a card or a menu (what is known about a file may have changed). */
export function onOfferedRan(listener: () => void): () => void { ranListeners.add(listener); return () => { ranListeners.delete(listener); }; }

/** Runs one tool (each input filled from what the thing carries) or opens one screen on a file or a thing the Workshop offered;
 *  answers the words to show. */
export async function doOffered(action: Offered, carried: Carried, file?: { identity: string; name: string; type: string; path?: string | null; bytes?: string }, thing?: Thing): Promise<string> {
  if (action.kind === 'open' && file) {
    const name = file.path ? file.path.slice(file.path.lastIndexOf('/') + 1) : file.name;
    openScreenOn(action.surface!, filled(action.input ?? {}, { identity: file.identity, name, type: file.type, folder: file.path ? folderOf(file.path) : '/', bytes: file.bytes ?? '' }) as Record<string, unknown>, file.name);
    return data.said.opened;
  }
  if (action.kind === 'open' && thing) {
    openScreenOn(action.surface!, filled(action.input ?? {}, { id: thing.id, kind: thing.kind, address: `${thing.kind}:${thing.id}` }, 'thing') as Record<string, unknown>, thing.title);
    return data.said.opened;
  }
  await runWorkshopTool(action.id, Object.fromEntries(Object.entries(action.fills ?? {}).map(([input, format]) => [input, carried[format]])), newRunKey('menu'));
  for (const listener of ranListeners) listener();
  return data.said.done;
}

/** Sends the thing (and anything more) to the person's own AI through the one delivery road. */
async function deliver(thing: Thing, body: { action?: string; own_words?: string; more?: ShareItem[] }): Promise<string> {
  const items = [...(thing.share ? [thing.share] : []), ...(body.more ?? [])];
  const answer = await postJson<Delivered>('/work/api/share-destinations/deliver', {
    items, to: data.send_to, request_key: crypto.randomUUID(),
    from: data.from, from_agent: data.from_agent, ...(body.action ? { action: body.action } : {}), ...(body.own_words ? { own_words: body.own_words } : {}),
  });
  if (answer.stopped_at) throw new Error(answer.stopped_at.error);
  return data.said.sent;
}

// The sidebar list holding each tool folder names it in a menu too (surfaces.json sidebar_collections, at any depth: a
// list may sit inside another list's `lists`).
type Held = { name?: string; icon?: string; holds?: { path?: string[]; equals?: string }; [field: string]: unknown };
function foldersIn(value: unknown, into = new Map<string, { label: string; icon: string }>()) {
  if (Array.isArray(value)) { for (const item of value) foldersIn(item, into); return into; }
  if (!value || typeof value !== 'object') return into;
  const list = value as Held;
  if (list.holds?.equals && list.holds.path?.join('.') === 'source.group' && list.name) into.set(list.holds.equals, { label: list.name, icon: list.icon ?? 'Folder' });
  for (const inner of Object.values(list)) if (inner && typeof inner === 'object') foldersIn(inner, into);
  return into;
}
const FOLDERS = foldersIn(surfaces.sidebar_collections);
// The message box and the sharing sheet open from a menu, so their code is fetched when one is opened, not with the page.
const Composer = lazyPart(() => import('../../parts/ui/show/composer'), module => module.Composer);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).replace(/[-_]+/g, ' ');

// The message box arrives the first time it is drawn (parts/ui/show/composer/lazy-composer.ts); what sends its files and
// reads its links is fetched the first time a menu opens it.
const sending = () => import('./send-message');
const readPastedLink = (url: string) => sending().then(module => module.readPastedLink(url));

/** The message box inside the menu: what is written, said, filmed or attached goes to the person's AI with the thing. */
function WritePanel({ thing, close }: { thing: Thing; close: () => void }) {
  const [saved, setSaved] = React.useState<Saved | null>(null);
  const [action, setAction] = React.useState<string | null>(null);
  React.useEffect(() => { savedActions().then(setSaved, () => setSaved({ actions: [] })); }, []);
  const send = async (draft: ComposerDraft) => {
    const kept = await (await sending()).keepFiles(draft);
    const more: ShareItem[] = [
      ...draft.links.map(url => ({ kind: 'link', url })),
      ...kept.map((file, index) => ({ kind: ['image', 'video', 'audio'].find(kind => (draft.files[index]?.type ?? '').startsWith(`${kind}/`)) ?? 'file', name: file.name, file: file.identity })),
    ];
    const said = await deliver(thing, { ...(action ? { action } : {}), ...(draft.text.trim() ? { own_words: draft.text.trim() } : {}), more });
    window.setTimeout(close, 900);
    return said;
  };
  return (
    <React.Suspense fallback={null}><Composer
      onSend={send}
      carries
      context={[{ id: thing.id, label: thing.title, icon: 'Paperclip' }]}
      pickers={saved?.actions.length ? [actionPicker(saved, action, setAction)] : []}
      readLink={readPastedLink}
      words={{ placeholder: fill(data.write.placeholder, { title: thing.title }), send: data.write.send }}
    /></React.Suspense>
  );
}

/** Rows a part of this page offers for a thing from state only the page holds (a screen's own arrangement), as one
 *  more source beside the DATA ones (menu-rows.json `from: "page"`). */
export type PageRows = (thing: Thing) => Row[];
const pageRows = new Set<PageRows>();
const pageRowsChanged = new Set<() => void>();
/** Offers `rows` for every thing from now on; answers the call that takes them away. */
export function providePageRows(rows: PageRows): () => void {
  pageRows.add(rows);
  announcePageRows();
  return () => { pageRows.delete(rows); announcePageRows(); };
}
/** Says the page's own rows changed, so every menu works its rows out again. */
export function announcePageRows(): void { for (const changed of pageRowsChanged) changed(); }

type Reader = (thing: Thing) => Promise<Row[]>;
const READERS: Record<string, Reader> = {
  // What parts of this page offer for this thing from their own state (providePageRows).
  async page(thing) { return [...pageRows].flatMap(rows => rows(thing)); },
  // Every tool and screen that takes this thing, in the folder each sits in.
  async tools(thing) {
    const carried = carriedOf(thing);
    const isFile = Boolean(carried[FILE_FORMAT]);
    const offered = await offeredFor(carried, isFile ? { type: thing.media_type ?? '', name: thing.name ?? thing.title } : undefined);
    const screens = new Set(offeredScreens().map(screen => screen.id));
    const rows = offered.filter(action => action.kind !== 'open' || screens.has(action.surface!)).map((action): Row => ({
      id: `menu:tool:${action.id}`, label: action.label, icon: action.icon, ...(action.group ? { group: action.group } : {}),
      run: target => doOffered(action, carriedOf(target), isFile ? { identity: target.id, name: target.name ?? target.title, type: target.media_type ?? '', path: typeof target.path === 'string' ? target.path : null, bytes: typeof target.url === 'string' ? target.url.split('#')[0] : '' } : undefined, target),
    }));
    const loose = rows.filter(row => !row.group);
    const folders = [...new Set(rows.map(row => row.group).filter((group): group is string => Boolean(group)))];
    return [...loose, ...folders.map((folder): Row => {
      const named = FOLDERS.get(folder) ?? { label: capital(folder), icon: 'Folder' };
      return { id: `menu:tool-folder:${folder}`, label: named.label, icon: named.icon, items: rows.filter(row => row.group === folder).map(({ group: _group, ...row }) => row) };
    })];
  },
  // The person's own saved actions, each folder its own submenu, after the message box.
  async 'saved-actions'(thing) {
    const saved = await savedActions();
    const rowsOf = (nodes: Node[]): Row[] => nodes.map(node => ('action' in node
      ? { id: `menu:action:${node.action.id}`, label: node.action.label, icon: 'Sparkles', run: target => deliver(target, { action: node.action.id }) }
      : { id: `menu:action-folder:${node.folder.id}`, label: node.folder.label, icon: 'Folder', items: rowsOf(node.rows) }));
    return [
      { id: 'menu:write', label: data.write.label, icon: data.write.icon, panel: close => <WritePanel thing={thing} close={close} /> },
      ...rowsOf(actionTree({ actions: saved.actions, folders: saved.folders ?? [] }) as Node[]),
    ];
  },
  // A record its store kept as two versions (two devices changed it apart): the view that settles it, inside the menu.
  async versions(thing) {
    return versionsRows(thing) as Row[];
  },
  // The same inspection gesture follows any exact record reference supplied by its owner.
  // Sharing addresses are resolved by the EEAF model reader, never guessed from a title.
  async inspection(thing) {
    const share = thing.share as { kind?: string; record?: string; file?: string } | undefined;
    const ref = typeof thing.record === 'string' ? thing.record
      : share?.kind === 'record' ? share.record
        : share?.kind === 'file' ? `file:${share.file}` : null;
    if (!ref) return [];
    return [{ id: 'menu:inspection', label: data.inspection.label, icon: data.inspection.icon,
      run: async target => { openScreenOn(data.inspection.screen, { item: ref }, target.title); return data.said.opened; } }];
  },
  // Share: the one sharing sheet for what the thing names (a record, a file, a part of a record, or a space).
  async sharing(thing) {
    const share = thing.share as { kind?: string; record?: string; file?: string } | undefined;
    const ref = data.share.kinds_as_space.includes(thing.kind) ? `space:${thing.id}` : share?.kind === 'record' ? share.record : share?.kind === 'file' ? `file:${share.file}` : null;
    if (!ref) return [];
    return [{ id: 'menu:share', label: data.share.label, icon: data.share.icon, run: async target => { const anchor = document.activeElement; (await import('./sharing-sheet')).openSharing(ref, { title: target.title, anchor }); return ''; } }];
  },
  // Every format, by category, each asking the person's AI to make the thing into it.
  async formats(thing) {
    const listed = await formats();
    const rowOf = (format: Format): Row => ({ id: `menu:format:${format.id}`, label: format.label, icon: format.icon ?? 'Shapes', run: target => deliver(target, { own_words: fill(data.format_words, { title: target.title, format: format.label }) }) });
    const categories = [...new Set(listed.map(format => format.category_id ?? format.category ?? ''))];
    if (categories.length < 2) return listed.map(rowOf);
    return categories.map(category => {
      const inside = listed.filter(format => (format.category_id ?? format.category ?? '') === category);
      return { id: `menu:format-category:${category || 'other'}`, label: inside[0]?.category ?? capital(category), icon: inside[0]?.category_icon ?? 'Shapes', items: inside.map(rowOf) };
    });
  },
};

/** This account's test group, so a rule can show rows to part of the people. */
const bucketOf = (): number => accountBucket(data.buckets);

/** The rows a show rule leaves, at every depth; a submenu left with nothing goes too. */
function shownRows(rows: Row[], thing: Thing, source: string): Row[] {
  return rows.flatMap(row => {
    const facts = { source, id: row.id, label: row.label, thing: thing.kind, media_type: thing.media_type ?? '', bucket: bucketOf() };
    if (showOf(SUBJECT, facts).hidden) return [];
    if (!row.items) return [row];
    const inside = shownRows(row.items as Row[], thing, source);
    return inside.length ? [{ ...row, items: inside }] : [];
  });
}

// A record reference names a kept file as `file:<identity>` (the sharing references every place uses).
const FILE_REF = /^file:(.+)$/;
/** The thing as the sources read it: a record that is a kept file is that file, and a thing with nothing to send says
 *  how it is sent: a record by its reference, a screen as a link to where it opens, anything else by its title. */
export function thingOf(given: Thing): Thing {
  const ref = typeof given.record === 'string' ? given.record : null;
  const file = ref ? FILE_REF.exec(ref)?.[1] : undefined;
  const thing: Thing = file ? { ...given, kind: 'file', id: file, name: given.name ?? given.title, share: given.share ?? { kind: 'file', file, name: given.name ?? given.title } } : given;
  if (thing.share) return thing;
  if (ref) return { ...thing, share: { kind: 'record', record: ref, title: thing.title } };
  const screen = thing.kind === 'screen' ? offeredScreens().find(row => row.id === thing.id) : undefined;
  const path = (screen?.route_paths as string[] | undefined)?.[0];
  if (path) return { ...thing, share: { kind: 'link', url: new URL(path, location.origin).href, title: thing.title } };
  return { ...thing, share: { kind: 'text', text: thing.title } };
}

/** Every row the sources offer for this thing, each source its own group (or one submenu), in menu-rows.json order. */
async function rowsFor(given: Thing): Promise<Row[]> {
  const thing = thingOf(given);
  const sources = data.sources.filter(source => !source.for_kinds.length || source.for_kinds.includes(thing.kind));
  const read = await Promise.all(sources.map(source => (READERS[source.from]?.(thing) ?? Promise.resolve([])).then(rows => shownRows(rows, thing, source.id), () => [] as Row[])));
  return sources.flatMap((source, index): Row[] => {
    const rows = read[index];
    if (!rows.length) return [];
    if (!source.nest) return rows.map(row => ({ ...row, group: `menu:${source.group}` }));
    return [{ id: `menu:${source.id}`, label: source.nest.label, icon: source.nest.icon, group: `menu:${source.group}`, items: rows }];
  });
}

const runOf = (rows: readonly ActionMenuItem[], id: string): Row | undefined => {
  for (const row of rows as Row[]) {
    if (row.id === id) return row;
    const inside = row.items ? runOf(row.items, id) : undefined;
    if (inside) return inside;
  }
  return undefined;
};

/** Installs the page's menu rows: every ActionMenu given `about` offers them from then on. Returns what takes them away. */
export function installMenuRows(): () => void {
  const kept = new Map<string, Row[]>();
  const keyOf = (thing: Thing) => JSON.stringify([thing.kind, thing.id, thing.media_type ?? '', thing.title]);
  // A rule saved or the clock passing a moment a rule names can change which rows show, so rows are worked out again.
  const stopHearing = onShowChange(() => { kept.clear(); announceMenuRows(); });
  const changed = () => { kept.clear(); announceMenuRows(); };
  pageRowsChanged.add(changed);
  // A record kept as two versions, or settled, changes the Two versions row of its menu.
  const stopVersions = onCatchUpChange(() => { kept.clear(); announceMenuRows(); });
  const stop = provideMenuRows({
    peek: thing => kept.get(keyOf(thing as Thing)) ?? null,
    rows: async thing => {
      const rows = await rowsFor(thing as Thing);
      kept.set(keyOf(thing as Thing), rows);
      if (kept.size > 200) kept.delete(kept.keys().next().value!);
      return rows;
    },
    act: async (thing, id) => {
      const row = runOf(kept.get(keyOf(thing as Thing)) ?? [], id);
      if (!row?.run) throw new Error('This can no longer be done here.');
      return row.run(thingOf(thing as Thing));
    },
  });
  return () => { stopHearing(); stopVersions(); pageRowsChanged.delete(changed); stop(); };
}
