// packages/funnel-offer-graph/do-work/create-funnel.test.ts
//
// The "make a funnel" builders are pure: create an honestly-empty funnel, append
// title-only stages deterministically, and emit an additive whole-record
// write-batch to the scoped-feed path. Zero I/O, zero randomness (entropy is
// injected), so every assertion is exact.

import { describe, expect, it } from 'vitest';
import {
  slugify,
  funnelSlug,
  funnelDefinitionAddress,
  buildNewFunnelDefinition,
  appendStage,
  buildFunnelDefinitionWrite,
} from './create-funnel';
import { readFunnelDefinition, resolveFunnelDefinition } from '../read-data/funnel-definition';

describe('slugify / funnelSlug', () => {
  it('normalizes human text to a url-safe slug', () => {
    expect(slugify('My Offer Ladder!')).toBe('my-offer-ladder');
    expect(slugify('  spaced  out  ')).toBe('spaced-out');
    expect(slugify('###')).toBe('');
  });
  it('takes the identity tail of a funnel id', () => {
    expect(funnelSlug('funnel:my-ladder-abc')).toBe('my-ladder-abc');
    expect(funnelSlug('bare')).toBe('bare');
  });
});

describe('buildNewFunnelDefinition', () => {
  it('authors an HONESTLY EMPTY funnel (no fake/demo stages, L117)', () => {
    const def = buildNewFunnelDefinition('Offer Ladder', 'k9');
    expect(def.kind).toBe('funnel-definition');
    expect(def.id).toBe('funnel:offer-ladder-k9');
    expect(def.title).toBe('Offer Ladder');
    expect(def.stages).toEqual([]); // empty — the user fills it, nothing invented
  });
  it('falls back to entropy for the id when the title has no slug-able chars, but preserves the typed title', () => {
    const def = buildNewFunnelDefinition('###', 'z7');
    expect(def.id).toBe('funnel:z7'); // slug empty → id is the entropy alone
    expect(def.title).toBe('###'); // the typed title is preserved honestly
  });
  it('omits a truly blank title (never fabricates one)', () => {
    const def = buildNewFunnelDefinition('   ', 'z7');
    expect(def.id).toBe('funnel:z7');
    expect(def.title).toBeUndefined();
  });
  it('gives same-title funnels distinct stable ids via injected entropy', () => {
    expect(buildNewFunnelDefinition('Sales', 'a').id).not.toBe(buildNewFunnelDefinition('Sales', 'b').id);
  });
});

describe('appendStage', () => {
  it('appends ONE title-only stage with a deterministic collision-free address', () => {
    const def = buildNewFunnelDefinition('Ladder', 'x1');
    const one = appendStage(def, 'Visited');
    expect(one.stages).toHaveLength(1);
    expect(one.stages[0]).toEqual({ stage_address: 'stage:ladder-x1:s1', title: 'Visited' });
    const two = appendStage(one, 'Bought');
    expect(two.stages).toHaveLength(2);
    expect(two.stages[1].stage_address).toBe('stage:ladder-x1:s2');
    // purity: the earlier defs are untouched
    expect(def.stages).toHaveLength(0);
    expect(one.stages).toHaveLength(1);
  });
  it('never collides even if an ordinal address already exists', () => {
    const def = { kind: 'funnel-definition' as const, id: 'funnel:f', stages: [{ stage_address: 'stage:f:s1' }] };
    const next = appendStage(def, 'Second');
    expect(next.stages[1].stage_address).toBe('stage:f:s2');
  });
});

describe('buildFunnelDefinitionWrite', () => {
  it('emits an additive whole-record write-batch to the scoped-feed path', () => {
    const def = appendStage(buildNewFunnelDefinition('Ladder', 'x1'), 'Visited');
    const req = buildFunnelDefinitionWrite(def);
    expect(req.target).toBe('engine.operation.label-addressed');
    expect(req.payload.operation_label).toBe('engine.operation.write-batch');
    expect(req.payload.writes).toHaveLength(1);
    const w = req.payload.writes[0];
    expect(w.address_label).toBe('package::funnel-offer-graph::published-record::funnel-definition::ladder-x1');
    expect(w.address_mode).toBe('identity_text');
    // MUST land at the path the funnel::funnel-definition-list feed reads.
    expect(w.path_labels).toEqual(['current-item', 'published-record']);
    expect(funnelDefinitionAddress(def.id)).toBe(w.address_label);
    // the payload IS a valid funnel-definition record
    expect(w.payload.kind).toBe('funnel-definition');
  });
});

describe('round-trip: authored funnel reads back + resolves', () => {
  it('a created + one-step funnel re-reads as a valid definition', () => {
    const authored = appendStage(buildNewFunnelDefinition('Ladder', 'x1'), 'Visited');
    const written = buildFunnelDefinitionWrite(authored).payload.writes[0].payload;
    const reread = readFunnelDefinition(written);
    expect(reread).not.toBeNull();
    expect(reread!.id).toBe('funnel:ladder-x1');
    expect(reread!.stages).toHaveLength(1);
    expect(reread!.stages[0].title).toBe('Visited');
  });
  it('the authored funnel RESOLVES + renders a stage (not the empty state)', () => {
    const authored = appendStage(buildNewFunnelDefinition('Ladder', 'x1'), 'Visited');
    const resolved = resolveFunnelDefinition([authored]);
    expect(resolved).not.toBeNull();
    expect(resolved!.stages).toHaveLength(1);
    // title-only stage self-names via the schema's `title?` (no workflow node)
    expect(resolved!.stages[0].title).toBe('Visited');
    expect(resolved!.stages[0].conversion_rate).toBe(0); // honest 0% — no measures yet
  });
});
