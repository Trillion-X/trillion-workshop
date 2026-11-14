// src/workspace/file-facts-store.ts
//
// PURPOSE
//   Where Files and Media read and keep the facts about each file: its namespace result of kind `facts` (the same one
//   every AI reads with read_file_results and sets with set_file_facts). Reads a folder's facts in one request, keeps a
//   person's edit as a merge of only that fact, keeps the fields a person added across their devices, and reads a
//   video's or picture's own bytes once for when and where it was captured (src/container-facts.mjs).
//
// NON-NEGOTIABLE INVARIANTS
//   1. One store: the facts result beside the file. A person's edit changes only the fact they edited.
//   2. A file's own bytes are read at most once per page for each file, and never again once its facts say they were
//      read (file-facts.json `read_mark`); what they give never replaces a fact a person or an AI already set.
//   3. Reading the bytes asks only for the few ranges the facts sit in, a few files at a time.

import { readContainerFacts } from '../container-facts.mjs';
import { FILE_FACTS, factsFromFile, personField } from './file-facts.mjs';
import { fileResults } from './api';
import { readWorkspacePreference, writeWorkspacePreference } from '#workspace-records';

export type Facts = Record<string, unknown>;
export type PersonField = { id: string; label: string; kind: string };

const MANY = 1000;
const AT_ONCE = 3;
const FIRST_READ = 65536;
const KIND = FILE_FACTS.result_kind as string;

/** Each file's facts, by the identity it was asked by; a file with none is left out. */
export async function readFacts(identities: string[]): Promise<Map<string, Facts>> {
  const found = new Map<string, Facts>();
  const unique = [...new Set(identities)];
  for (let at = 0; at < unique.length; at += MANY) {
    const answer = await fileResults.many<{ results: Record<string, Facts> }>(KIND, unique.slice(at, at + MANY));
    for (const [identity, facts] of Object.entries(answer.results)) found.set(identity, facts);
  }
  return found;
}

/** Sets (or, with null, takes away) only the named facts of one file; answers every fact it now has. */
export async function setFacts(identity: string, patch: Facts, producedBy = 'trillion files', onlyIfEmpty = false): Promise<Facts> {
  const answer = await fileResults.merge<{ value: Facts }>(identity, { kind: KIND, value: patch, produced_by: producedBy, ...(onlyIfEmpty ? { only_if_empty: true } : {}) });
  return answer.value;
}

/** The fields this person added to their files, kept with their workspace across devices. */
export const personFields = (): PersonField[] => (readWorkspacePreference<PersonField[]>(FILE_FACTS.person_fields_preference) ?? []).map(personField);

/** Keeps one more field of the person's own; a field with the same name is left as it is. */
export async function addPersonField(input: { id: string; label: string; kind?: string }): Promise<PersonField[]> {
  const held = personFields();
  if (held.some(field => field.id === input.id)) return held;
  const next = [...held, personField(input)];
  await writeWorkspacePreference(FILE_FACTS.person_fields_preference, next);
  return next;
}

// A stored file's bytes, read by range with this page's session: its length comes with the first range.
async function openBytes(address: string) {
  const first = await fetch(address, { credentials: 'same-origin', headers: { range: `bytes=0-${FIRST_READ - 1}` } });
  if (!first.ok) throw new Error(`The file could not be read (${first.status}).`);
  const head = new Uint8Array(await first.arrayBuffer());
  const size = Number(/\/(\d+)$/.exec(first.headers.get('content-range') ?? '')?.[1] ?? head.length);
  const read = async (offset: number, length: number) => {
    if (offset + length <= head.length) return head.subarray(offset, offset + length);
    const answer = await fetch(address, { credentials: 'same-origin', headers: { range: `bytes=${offset}-${offset + length - 1}` } });
    if (!answer.ok) throw new Error(`The file could not be read (${answer.status}).`);
    return new Uint8Array(await answer.arrayBuffer());
  };
  return { read, size };
}

/** A file whose own bytes can say when and where it was captured: its identity, bytes address, type and facts held. */
export type Readable = { identity: string; bytes: string | null | undefined; contentType: string; facts: Facts | null | undefined };

const tried = new Set<string>();
const FAMILIES = /^(video|audio|image)\//i;
const needsWebmTracks = (item: Readable) => /^audio\/webm(?:;|$)/i.test(item.contentType)
  && !Array.isArray(item.facts?.media_tracks);

/** Reads each file's own bytes once for the facts it holds about itself, a few at a time, keeps what it found, and
 *  hands each file's facts to `found` as they arrive. Returns a stop for when the screen closes. */
export function readFactsFromFiles(items: Readable[], found: (identity: string, facts: Facts) => void): () => void {
  let stopped = false;
  // Earlier reads of WebM returned no track facts but did stamp the read mark. Revisit only ambiguous audio-labeled
  // WebMs once so an actual video track can correct that old label, without rereading every stored recording.
  const queue = items.filter(item => item.bytes && FAMILIES.test(item.contentType)
    && (!(item.facts && FILE_FACTS.read_mark in item.facts) || needsWebmTracks(item)) && !tried.has(item.identity));
  for (const item of queue) tried.add(item.identity);
  const work = async () => {
    for (let item = queue.shift(); item && !stopped; item = queue.shift()) {
      try {
        const { read, size } = await openBytes(item.bytes!);
        const facts = await readContainerFacts(read, size);
        if (stopped) { tried.delete(item.identity); return; }
        found(item.identity, await setFacts(item.identity, factsFromFile(item.facts, facts, new Date().toISOString()), 'trillion file facts', true));
      } catch {
        // A file that cannot be read now keeps no mark and is read again on a later visit.
        tried.delete(item.identity);
      }
    }
  };
  for (let worker = 0; worker < AT_ONCE; worker += 1) void work();
  return () => { stopped = true; for (const item of queue) tried.delete(item.identity); };
}
