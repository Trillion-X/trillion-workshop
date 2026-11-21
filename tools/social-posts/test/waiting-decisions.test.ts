// The waiting-on-a-yes statements, made from pieces.json's decision DATA alone. The SQL is checked as text here; the live
// run of the same statements against the database is recorded in the reflection, not in this file.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { approvable, decideStatement, identifier, isBlank, readFields, shownWords, waitingCountStatement, waitingPageStatement, type DecisionSource } from '../web/src/workspace/decisions.ts';

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

  it('gives every page a size from DATA, as a whole number above zero', () => {
    expect(Number.isInteger(DATA.waiting_page_size)).toBe(true);
    expect(DATA.waiting_page_size).toBeGreaterThan(0);
  });

  it('gives every statement a statement timeout from DATA, as a whole number of milliseconds above zero', () => {
    expect(Number.isInteger(DATA.statement_timeout_ms)).toBe(true);
    expect(DATA.statement_timeout_ms).toBeGreaterThan(0);
  });

  it('gives Approve and Skip two different one-letter keys, and shows the rows one at a time', () => {
    expect(outreach.yes.key).toMatch(/^[a-z]$/);
    expect(outreach.skip.key).toMatch(/^[a-z]$/);
    expect(outreach.yes.key).not.toBe(outreach.skip.key);
    expect(outreach.one_at_a_time).toBe(true);
  });
});

describe('an email draft with no address', () => {
  it('offers no Approve, and the empty list is blank', () => {
    expect(isBlank('[]', 'list')).toBe(true);
    expect(isBlank(null, 'list')).toBe(true);
    expect(isBlank('["a@example.com"]', 'list')).toBe(false);
    expect(approvable(outreach, { emails: '[]' })).toBe(false);
    expect(approvable(outreach, { emails: null })).toBe(false);
    expect(approvable(outreach, { emails: '["a@example.com"]' })).toBe(true);
  });

  it('shows its own empty words in place of the list, from DATA the words file holds', () => {
    const emails = outreach.shows.find(shown => shown.field === 'emails');
    expect(emails?.empty).toBe('no_address');
    expect(DATA.words[emails!.empty!]).toBe('No address found');
  });

  it('keeps Skip for it: a source with no yes_needs offers Approve for every row', () => {
    expect(approvable({ ...outreach, yes_needs: undefined }, { emails: '[]' })).toBe(true);
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

describe('waitingPageStatement', () => {
  it('reads the first page of the waiting rows, in the source order, with the waiting status and the size as its values', () => {
    const made = waitingPageStatement(outreach, 50, null);
    expect(made.sql).toBe('select "place_id", "name", "drafted_at", "category", "website", "address", "phone", "emails", "subject", "body", "why", "detail" from "outreach_drafts" where "status" = $1 order by "drafted_at", "place_id" limit $2');
    expect(made.params).toEqual(['waiting on a yes', '50']);
  });

  it('reads the next page keyset-style, after the order and id of the last row shown, with no offset', () => {
    const made = waitingPageStatement(outreach, 50, { order: '2026-11-02T00:00:00Z', id: 'p2' });
    expect(made.sql).toContain('and ("drafted_at", "place_id") > ($2, $3) order by "drafted_at", "place_id" limit $4');
    expect(made.sql).not.toContain('offset');
    expect(made.params).toEqual(['waiting on a yes', '2026-11-02T00:00:00Z', 'p2', '50']);
  });

  it('refuses a page size that is not a whole number above zero', () => {
    expect(() => waitingPageStatement(outreach, 0, null)).toThrow();
    expect(() => waitingPageStatement(outreach, 1.5, null)).toThrow();
  });

  it('reads each field once even when it is both the order and a shown field', () => {
    const fields = readFields({ ...outreach, shows: [...outreach.shows, { field: 'drafted_at', label: 'Drafted' }] });
    expect(fields.filter(field => field === 'drafted_at').length).toBe(1);
  });

  it('keeps the values out of the text, whatever the DATA holds', () => {
    const odd = { ...outreach, waiting: "x'; drop table outreach_drafts; --" };
    const made = waitingPageStatement(odd, 50, null);
    expect(made.sql).not.toContain('drop table');
    expect(made.params).toEqual(["x'; drop table outreach_drafts; --", '50']);
  });
});

describe('waitingCountStatement', () => {
  it('counts the same rows the pages read, with the waiting status as its one value', () => {
    const made = waitingCountStatement(outreach);
    expect(made.sql).toBe('select count(*) as waiting from "outreach_drafts" where "status" = $1');
    expect(made.params).toEqual(['waiting on a yes']);
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
