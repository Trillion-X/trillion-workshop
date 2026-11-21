// The waiting-on-a-yes statements run on PGlite (an in-process Postgres) with the outreach_drafts columns: the rows that
// wait are read in order, Approve and Skip change only a row that still waits, and a repeat decision changes nothing.
// Nothing here touches a real database; the PGlite instance is discarded when the test ends.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { decideStatement, waitingCountStatement, waitingPageStatement, type DecisionSource } from '../web/src/workspace/decisions.ts';

const DATA = JSON.parse(readFileSync(new URL('../web/src/workspace/pieces.json', import.meta.url), 'utf8'));
const outreach = DATA.decisions.sources[0] as DecisionSource;

async function drafts(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create table outreach_drafts (
      place_id text primary key, name text, category text, website text, address text, phone text, emails jsonb,
      subject text, body text, detail text, why text, status text not null default 'waiting on a yes',
      drafted_at timestamptz, decided_at timestamptz
    );
    insert into outreach_drafts (place_id, name, category, emails, subject, body, status, drafted_at) values
      ('p3', 'Third Floor', 'Flooring', '["a@example.com","b@example.com"]', 'Third', 'Body three', 'waiting on a yes', '2026-11-03T00:00:00Z'),
      ('p1', 'First Floor', 'Flooring', '[]', 'First', 'Body one', 'waiting on a yes', '2026-11-01T00:00:00Z'),
      ('p2', 'Second Floor', null, '[]', 'Second', 'Body two', 'waiting on a yes', '2026-11-02T00:00:00Z'),
      ('p4', 'Decided Floor', null, '[]', 'Old', 'Old body', 'approved', '2026-10-30T00:00:00Z');
  `);
  return db;
}

const waitingIds = async (db: PGlite, size = 50) => {
  const { sql, params } = waitingPageStatement(outreach, size, null);
  return (await db.query<{ place_id: string }>(sql, params)).rows.map(row => row.place_id);
};

/** Every page of the waiting rows, size by size, each after the last row of the one before (keyset, never an offset). */
const pagesOf = async (db: PGlite, size: number) => {
  const pages: string[][] = [];
  let after: { order: string; id: string } | null = null;
  for (;;) {
    const { sql, params } = waitingPageStatement(outreach, size, after);
    const rows: { place_id: string; drafted_at: string }[] = (await db.query<{ place_id: string; drafted_at: string }>(sql, params)).rows;
    if (rows.length === 0) return pages;
    pages.push(rows.map(row => row.place_id));
    const last = rows[rows.length - 1]!;
    after = { order: new Date(last.drafted_at).toISOString(), id: last.place_id };
  }
};

describe('the waiting rows on a database', () => {
  it('reads every row whose status is the waiting value, in the source order, and no other', async () => {
    const db = await drafts();
    expect(await waitingIds(db)).toEqual(['p1', 'p2', 'p3']);
    await db.close();
  });

  it('pages through every waiting row, size by size, with no row twice and none missed', async () => {
    const db = await drafts();
    expect(await pagesOf(db, 2)).toEqual([['p1', 'p2'], ['p3']]);
    expect(await pagesOf(db, 1)).toEqual([['p1'], ['p2'], ['p3']]);
    await db.close();
  });

  it('counts the rows that wait, the same rows the pages read', async () => {
    const db = await drafts();
    const { sql, params } = waitingCountStatement(outreach);
    expect((await db.query<{ waiting: number }>(sql, params)).rows).toEqual([{ waiting: 3 }]);
    await db.close();
  });

  it('Approve sets the approved status and stamps decided_at, then the row leaves the waiting list', async () => {
    const db = await drafts();
    const { sql, params } = decideStatement(outreach, outreach.yes, 'p1');
    expect((await db.query<{ place_id: string }>(sql, params)).rows).toEqual([{ place_id: 'p1' }]);
    expect((await db.query(`select status, decided_at is not null as stamped from outreach_drafts where place_id = 'p1'`)).rows).toEqual([{ status: 'approved', stamped: true }]);
    expect(await waitingIds(db)).toEqual(['p2', 'p3']);
    await db.close();
  });

  it('Skip sets the skipped status; a repeat decision on a decided row changes nothing', async () => {
    const db = await drafts();
    const skip = decideStatement(outreach, outreach.skip, 'p2');
    expect((await db.query(skip.sql, skip.params)).rows).toEqual([{ place_id: 'p2' }]);
    expect((await db.query(`select status from outreach_drafts where place_id = 'p2'`)).rows).toEqual([{ status: 'skipped' }]);
    const again = decideStatement(outreach, outreach.yes, 'p2');
    expect((await db.query(again.sql, again.params)).rows).toEqual([]);
    expect((await db.query(`select status from outreach_drafts where place_id = 'p2'`)).rows).toEqual([{ status: 'skipped' }]);
    await db.close();
  });

  it('leaves a decided row and every other waiting row exactly as they were', async () => {
    const db = await drafts();
    const { sql, params } = decideStatement(outreach, outreach.yes, 'p4');
    expect((await db.query(sql, params)).rows).toEqual([]);
    expect((await db.query(`select status, decided_at from outreach_drafts where place_id = 'p4'`)).rows).toEqual([{ status: 'approved', decided_at: null }]);
    expect(await waitingIds(db)).toEqual(['p1', 'p2', 'p3']);
    await db.close();
  });
});
