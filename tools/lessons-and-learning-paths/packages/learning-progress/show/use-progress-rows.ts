// tools/lessons-and-learning-paths/packages/learning-progress/show/use-progress-rows.ts
//
// PURPOSE
//   The rows the learner progress screen draws, read through the records door: one list per kind the screen reads
//   (read-data/progress-row-types.json). The retired screen asked the Bitfield runtime for every published record
//   (`useBitfieldData('published-records')`); here each kind is its own list of the person's own rows. Each row is
//   handed on as { address, payload } in the shape read-data/read-learning-progress.ts takes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only rows read from the lists the declared types name are handed on; nothing here lists a track or a learner.
//   2. The owner address a progress state or an evaluation receipt needs is given by read-data/progress-rows.mjs,
//      to the rows of their own lists only.
//   3. Nothing here writes a row.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { listRecords } from '#workspace/records-door';
import rowTypes from '../read-data/progress-row-types.json' with { type: 'json' };
import { progressRowsOf } from '../read-data/progress-rows.mjs';

type ProgressRow = { address: string; payload: Record<string, unknown> };

async function readProgressRows(): Promise<ProgressRow[]> {
  const read = await Promise.all(rowTypes.lists.map(async list => [list.type, await listRecords({ type: list.type })] as const));
  return progressRowsOf(rowTypes, Object.fromEntries(read));
}

export function useProgressRows(): ProgressRow[] {
  const [rows, setRows] = React.useState<ProgressRow[]>([]);
  React.useEffect(() => {
    let gone = false;
    void readProgressRows().then(read => { if (!gone) setRows(read); });
    return () => { gone = true; };
  }, []);
  return rows;
}
