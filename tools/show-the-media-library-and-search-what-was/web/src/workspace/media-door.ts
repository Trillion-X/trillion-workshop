// src/workspace/media-door.ts
//
// PURPOSE
//   Every door call the Media screen makes, in one place: a SQL read of the person's own database (tool:run-sql-in-my-database,
//   media-library-owner.json), a read of their files owner (tool:your-files: thumbnail, read_file_span), and the picture
//   embedding a search asks for. Each call takes a slot at the door, at most two at once, so the library, the pictures and
//   the playback never stack more calls on the Mac's door than the lane allows.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a table or a record: the SQL is the caller's, the tools and credential are DATA.
//   2. At most two calls are in flight. A slot handed to a waiting call is taken at once, never freed and retaken.
//   3. A failed call throws with the tool's own words; nothing is answered in its place.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { runWorkshopTool } from '../../../../workspace-screens/web/src/workspace/workshop-tool-api';
import { files } from '../../../../workspace-screens/web/src/workspace/api';
import owner from './media-library-owner.json' with { type: 'json' };

const SLOTS = 2;
let running = 0;
const waiting: (() => void)[] = [];

/** Run one door call when a slot is free. */
export async function atTheDoor<T>(call: () => Promise<T>): Promise<T> {
  if (running < SLOTS) running += 1;
  else await new Promise<void>(resolve => waiting.push(resolve));
  try {
    return await call();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}

/** The rows of one SQL read of the person's own database. */
export async function sqlRows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const ran = await atTheDoor(() => runWorkshopTool<{ rows?: T[] }>(owner.tool, { credential_name: owner.credential_name, sql, params }));
  if (!Array.isArray(ran.result?.rows)) throw new Error(ran.error || '');
  return ran.result.rows;
}

/** One of the files owner's operations (tool:your-files), answered as its own structured answer. */
export const filesRead = <T>(name: string, args: Record<string, unknown>) => atTheDoor(() => files.read(name, args)) as Promise<T>;
