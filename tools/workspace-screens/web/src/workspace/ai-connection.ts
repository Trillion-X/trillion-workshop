// src/workspace/ai-connection.ts
//
// PURPOSE
//   The tour host's current presentation: the app's tour words and the reader of the facts a tour step may wait on. The welcome tour's connect step (walkthroughs/first-run.json) waits on no fact: it
//   shows each AI app's setup and the person moves on with Next.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One fact, one address: a fact a step waits on is read only at its one admitted address (src/tour-word-content.mjs
//      factReads), which tour-words.json can only name; a tour's reads are gated by its published words.
//   2. No words here: what a step says is the tour's DATA; what every tour says, tour-words.json.

import { keptAccount } from '../../parts/ui/show/page-storage/page-storage';
import { checkedTourWordContent, tourFactBridge } from '../tour-word-content.mjs';
import { presentationRows } from './presentation-rows.mjs';
import { readJson } from './api';

const session = () => JSON.stringify(keptAccount());
const unavailable = () => Object.assign(new Error('The tour fact is not currently available.'), { code: 'tour_fact_unavailable' });
const read = (path: string) => readJson<unknown>(path, { cache: 'no-store' }, false, { applyFocus: false });

/** A mounted host owns one selected presentation. Both its facts and its words
 * belong to that snapshot; current() invalidates late reads when it is replaced. */
export async function currentTourPresentation(current: () => void = () => {}) {
  const started = session();
  const check = () => { current(); if (session() !== started) throw unavailable(); };
  check();
  const supplied = await presentationRows('tour-words');
  check();
  const rows = checkedTourWordContent(supplied);
  return { words: rows, ownerSignalBridge: tourFactBridge(rows, { read, current: check }) };
}
