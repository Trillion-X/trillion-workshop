// The waiting-on-a-yes statements, made from pieces.json's decision DATA alone. The SQL is checked as text here; the live
// run of the same statements against the database is recorded in the reflection, not in this file.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { decideStatement, identifier, readFields, shownWords, waitingRowsStatement, type DecisionSource } from '../web/src/workspace/decisions.ts';

const DATA = JSON.parse(readFileSync(new URL('../web/src/workspace/pieces.json', import.meta.url), 'utf8'));
const outreach = DATA.decisions.sources[0] as DecisionSource;

describe('the decision DATA', () => {
  it('names only plain identifiers, so no DATA value can reach the SQL text as a name', () => {
    for (const name of [outreach.table, outreach.id, outreach.title, outreach.status, outreach.decided_at, outreach.order, ...outreach.shows.map(shown => shown.field)]) {
      expect(() => identifier(name)).not.toThrow();
    }
  });

  it('gives Approve and Skip different statuses, neither of them the waiting one', () => {
    expect(outreach.yes.status).toBe('approved');
    expect(outreach.skip.status).toBe('skipped');
    expect(new Set([outreach.waiting, outreach.yes.status, outreach.skip.status]).size).toBe(3);
  });
});

describe('identifier', () => {
  it('quotes a plain name', () => {
    expect(identifier('outreach_drafts')).toBe('"outreach_drafts"');
  });

  it('refuses anything that is not a plain lower-case name', () => {
    for (const bad of ['Drafts', 'a b', 'x; drop table y', '"quoted"', '1st', '', 'a-b']) {
      expect(() => identifier(bad)).toThrow(/not a plain name/);
    }
  });
});

describe('waitingRowsStatement', () => {
  it('reads only the waiting rows, in the source order, with the waiting status as its one value', () => {
    const made = waitingRowsStatement(outreach);
    expect(made.sql).toBe('select "place_id", "name", "drafted_at", "category", "website", "address", "phone", "emails", "subject", "body", "why", "detail" from "outreach_drafts" where "status" = $1 order by "drafted_at", "place_id"');
    expect(made.params).toEqual(['waiting on a yes']);
  });

  it('reads each field once even when it is both the order and a shown field', () => {
    const fields = readFields({ ...outreach, shows: [...outreach.shows, { field: 'drafted_at', label: 'Drafted' }] });
    expect(fields.filter(field => field === 'drafted_at').length).toBe(1);
  });

  it('keeps the values out of the text, whatever the DATA holds', () => {
    const odd = { ...outreach, waiting: "x'; drop table outreach_drafts; --" };
    const made = waitingRowsStatement(odd);
    expect(made.sql).not.toContain('drop table');
    expect(made.params).toEqual(["x'; drop table outreach_drafts; --"]);
  });
});

describe('decideStatement', () => {
  it('sets the verb status and stamps decided_at, only on a row that still waits', () => {
    const made = decideStatement(outreach, outreach.yes, 'place:abc');
    expect(made.sql).toBe('update "outreach_drafts" set "status" = $1, "decided_at" = now() where "place_id" = $2 and "status" = $3 returning "place_id"');
    expect(made.params).toEqual(['approved', 'place:abc', 'waiting on a yes']);
  });

  it('makes Skip the same statement with the skip status', () => {
    const made = decideStatement(outreach, outreach.skip, 'place:abc');
    expect(made.params).toEqual(['skipped', 'place:abc', 'waiting on a yes']);
    expect(made.sql).toBe(decideStatement(outreach, outreach.yes, 'place:abc').sql);
  });

  it('never puts the row id into the text', () => {
    expect(decideStatement(outreach, outreach.yes, "p'; delete from outreach_drafts; --").sql).not.toContain('delete');
  });
});

describe('shownWords', () => {
  it('reads a list field from its JSON array as its items', () => {
    expect(shownWords('["first item","second item"]', 'list')).toBe('first item, second item');
  });

  it('keeps a list field that is not JSON as its text, and an empty one as nothing', () => {
    expect(shownWords('one item', 'list')).toBe('one item');
    expect(shownWords(null, 'list')).toBe('');
    expect(shownWords('[]', 'list')).toBe('');
  });

  it('shows any other field as its text, a missing one as nothing', () => {
    expect(shownWords('Line one\nLine two', undefined)).toBe('Line one\nLine two');
    expect(shownWords(null, 'text')).toBe('');
  });
});
