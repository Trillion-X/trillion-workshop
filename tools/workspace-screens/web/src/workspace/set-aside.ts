// src/workspace/set-aside.ts
//
// PURPOSE
//   The one way a workspace screen takes files out of view and gives them back: Files and Media offer one action per
//   state in src/namespace-set-aside.json ("Delete", "Archive"), each sending the chosen files, folders or recordings to
//   the person's files door on their computer (files-door.mjs: set_aside {name} at /work/api/files, every page of a
//   folder until no next_after is left; a recording by its identity is every name find_file gives it), then saying
//   where they went with a Put back (put_back {name}, the same pages) on the same notice. The Recently Deleted screen
//   puts back through `putBack` here too, by name. The door keeps one set-aside tree: every state's action sends there,
//   so Archive and Delete differ only in their words until the door keeps states.
//
// NON-NEGOTIABLE INVARIANTS
//   1. States are DATA: an action per row of namespace-set-aside.json `states`; nothing here names a state.
//   2. Nothing is taken out of view here: the Worker decides, and what it refused (a file still uploading) is said
//      with its own words.
//   3. Every control is shared: record views actions and the shared notifications.

import settings from '../namespace-set-aside.json';
import { notify } from '../../parts/ui/show/coss/notifications';
import type { BulkAction } from '../../parts/ui/show/record-views/record-views';
import { files } from './api';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
/** One thing to take out of view: a file or folder by its path, or a recording by its identity (every name it has). */
export type SetAsideItem = { name: string } | { identity: string; label?: string };
type Carried = { names?: unknown[]; next_after?: string | null };
type Found = { names?: string[] };
const lastPart = (name: string) => name.split('/').filter(Boolean).pop() ?? name;

/** One door move of a name or a whole folder (set_aside or put_back), every page until the door says no more. */
async function carry(operation: 'set_aside' | 'put_back', name: string): Promise<void> {
  let after: string | null | undefined = null;
  do {
    const page = await files.change(operation, { name, ...(after ? { after } : {}) }) as Carried;
    after = page.next_after;
  } while (after);
}

/** The names one item is: a path as itself, a recording by every name the door gives its identity. */
async function namesOf(item: SetAsideItem): Promise<{ name: string; label: string }[]> {
  if ('name' in item) return [{ name: item.name, label: lastPart(item.name) }];
  const found = await files.read('find_file', { name_or_identity: item.identity }) as Found;
  return (found.names ?? []).map(name => ({ name, label: item.label ?? lastPart(name) }));
}

/** Gives these names back where they were; says what could not come back. Answers how many came back. */
export async function putBack(ids: string[]): Promise<number> {
  const back: string[] = [];
  const stuck: { label: string; error: string }[] = [];
  for (const name of ids) {
    try { await carry('put_back', name); back.push(lastPart(name)); } catch (error) { stuck.push({ label: lastPart(name), error: errorWords(error) }); }
  }
  if (back.length) notify(back.length === 1 ? `${back[0]} is back` : `${back.length} are back`, { kind: 'restore' });
  if (stuck.length) notify(stuck.length === 1 ? `${stuck[0].label} could not be put back` : `${stuck.length} could not be put back`, { kind: 'error', detail: stuck[0].error });
  if (!back.length && !stuck.length) notify('Nothing was put back', { kind: 'error' });
  return back.length;
}

async function setAside(state: typeof settings.states[number], items: SetAsideItem[], after: () => void) {
  const moved: { name: string; label: string }[] = [];
  const refused: string[] = [];
  for (const item of items) {
    let names: { name: string; label: string }[] = [];
    try { names = await namesOf(item); } catch (error) { refused.push(errorWords(error)); continue; }
    for (const one of names) {
      try { await carry('set_aside', one.name); moved.push(one); } catch (error) { refused.push(errorWords(error)); }
    }
  }
  if (moved.length) {
    notify(moved.length === 1 ? `${state.set_aside_words}: ${moved[0].label}` : `${state.set_aside_words}: ${moved.length} items`, {
      kind: 'archive',
      actions: [{ label: 'Put back', onAction: () => { void putBack(moved.map(item => item.name)).then(after); } }],
    });
  }
  if (refused.length) notify(refused.length === 1 ? 'One was left where it is' : `${refused.length} were left where they are`, { kind: 'error', detail: refused[0] });
  after();
}

/**
 * The record-view actions a screen offers for its rows: one per state (Delete, Archive).
 *   itemOf:    what one row is, as a thing to take out of view, or null for a row that cannot be (a file uploading)
 *   after:     what the screen does once it has been asked (read itself again)
 */
export function setAsideActions<Row>(itemOf: (row: Row) => SetAsideItem | null, rowOf: (id: string) => Row | undefined, after: () => void): BulkAction[] {
  return settings.states.map(state => ({
    id: `set-aside:${state.id}`,
    label: state.action_label,
    icon: state.icon,
    ...('tone' in state ? { tone: state.tone } : {}),
    appliesTo: (row: Row) => itemOf(row) !== null,
    run: (ids: string[]) => {
      const items = ids.map(rowOf).filter((row): row is Row => row !== undefined).map(itemOf).filter((item): item is SetAsideItem => item !== null);
      if (items.length) void setAside(state, items, after);
    },
  }));
}
