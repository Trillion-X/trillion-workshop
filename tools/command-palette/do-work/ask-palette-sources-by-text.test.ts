// packages/command-palette/do-work/ask-palette-sources-by-text.test.ts
//
// Proves the generic palette-source descriptor seam is genuinely generic:
// reading descriptors, dispatching one, and mapping its reply into the exact
// PaletteQueryReply shape read-palette-results.ts already consumes —
// with ZERO code path specific to any one source. The deletion test swaps a
// media-shaped descriptor for a totally unrelated legal-docs-shaped one and
// asserts identical mechanics.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  readPaletteSourceDescriptorsFromReply,
  askPaletteSourceByText,
  askAllPaletteSourcesByText,
  mapDispatchItemToPaletteRow,
  type PaletteSourceDescriptor,
} from './ask-palette-sources-by-text';

vi.mock('#workspace-records', () => ({
  sendRequestToBitfieldTarget: vi.fn(),
}));

import { sendRequestToBitfieldTarget } from '#workspace-records';

const textEncoder = new TextEncoder();

function bytesReply(value: unknown): unknown {
  return { payload: textEncoder.encode(JSON.stringify(value)) };
}

beforeEach(() => {
  vi.mocked(sendRequestToBitfieldTarget).mockReset();
});

describe('readPaletteSourceDescriptorsFromReply', () => {
  it('reads any admitted palette-source-descriptor row regardless of domain', () => {
    const reply = bytesReply({
      items: [
        {
          payload: { kind: 'semantic-result-policy', id: 'capability-discovery-default', max_result_count: 2, max_schema_bytes_per_result: 64, total_prompt_budget_bytes: 96 },
        },
        {
          address: 'package::meaning-search::palette-source-descriptor::media-content',
          payload: {
            kind: 'palette-source-descriptor',
            id: 'media-content',
            result_policy_ref: 'semantic-result-policy:capability-discovery-default',
            authority_ref: 'authority:test',
            correlation_ref: 'query:test',
            hydration: { definition_id: 'action:hydrate-ranked-current-item', target: 'slot::find-current-items', address_field: 'address', revision_field: 'revision', payload_hash_field: 'content_hash' },
            dispatch: {
              target: 'slot::workflow',
              definition_id: 'action:find-similar',
              static_input: { index_id: 'media-content' },
              query_field: 'query_text',
              limit_field: 'limit',
            },
            result_mapping: {
              canonical_address_field: 'canonical_address', canonical_revision_field: 'canonical_revision',
              payload_hash_field: 'payload_hash', owner_target_field: 'owner_target', schema_ref_field: 'schema_ref',
              schema_digest_field: 'schema_digest', authority_provenance_ref_field: 'authority_provenance_ref',
              score_field: 'rank_score', rank_provenance_ref_field: 'rank_provenance_ref',
              id_field: 'canonical_address',
              group: 'Media',
              render_hint: 'tile',
            },
          },
        },
        {
          address: 'package::legal-docs::palette-source-descriptor::clause-search',
          payload: {
            kind: 'palette-source-descriptor',
            id: 'clause-search',
            result_policy_ref: 'semantic-result-policy:capability-discovery-default',
            dispatch: {
              target: 'slot::workflow',
              definition_id: 'action:search-clauses',
              query_field: 'text',
            },
            result_mapping: {
              title_field: 'clause_title',
              group: 'Legal Docs',
            },
          },
        },
        // Malformed row — missing dispatch.target — must be skipped, not crash.
        {
          address: 'package::broken::palette-source-descriptor::x',
          payload: { kind: 'palette-source-descriptor', id: 'broken' },
        },
        // Unrelated kind — must be ignored entirely.
        {
          address: 'package::other::some-other-kind::y',
          payload: { kind: 'some-other-kind', id: 'irrelevant' },
        },
      ],
    });

    const descriptors = readPaletteSourceDescriptorsFromReply(reply);
    expect(descriptors.map((d) => d.id).sort()).toEqual(['media-content']);

    const media = descriptors.find((d) => d.id === 'media-content')!;
    expect(media.dispatch.target).toBe('slot::workflow');
    expect(media.dispatch.definition_id).toBe('action:find-similar');
    expect(media.dispatch.static_input).toEqual({ index_id: 'media-content' });
    expect(media.result_mapping.render_hint).toBe('tile');

  });
});

describe('mapDispatchItemToPaletteRow', () => {
  it('maps any raw dispatch row into the shared row shape using only descriptor field names', () => {
    const mapped = mapDispatchItemToPaletteRow(
      { canonical_address: 'package::x::media::a1', score: 0.92, caption: 'Swing analysis clip' },
      { canonical_address_field: 'canonical_address', score_field: 'score', title_field: 'caption', group: 'Media', render_hint: 'tile' },
    );
    expect(mapped).toEqual({
      id: 'package::x::media::a1',
      address: 'package::x::media::a1',
      canonical_address: 'package::x::media::a1',
      title: 'Swing analysis clip',
      description: '',
      group: 'Media',
      render_hint: 'tile',
      score: 0.92,
      rank_score: 0.92,
    });
  });

  it('requires the mapped canonical address even when a display title can be derived', () => {
    const mapped = mapDispatchItemToPaletteRow(
      { address: 'package::legal-docs::clause::indemnification' },
      { group: 'Legal Docs' },
    );
    expect(mapped).toBeNull();
  });

  it('returns null when the row has no usable id', () => {
    expect(mapDispatchItemToPaletteRow({ score: 1 }, {})).toBeNull();
  });

  it('never aliases raw id or address to canonical_address', () => {
    expect(mapDispatchItemToPaletteRow({ id: 'human-id', address: 'package::not-canonical' }, { id_field: 'id' })).toBeNull();
  });
});

const MEDIA_DESCRIPTOR: PaletteSourceDescriptor = {
  id: 'media-content',
  dispatch: {
    target: 'slot::workflow',
    definition_id: 'action:find-similar',
    static_input: { index_id: 'media-content' },
    query_field: 'query_text',
    limit_field: 'limit',
  },
  result_mapping: {
    id_field: 'address', score_field: 'rank_score', group: 'Media', render_hint: 'tile',
    canonical_address_field: 'canonical_address', canonical_revision_field: 'canonical_revision',
    payload_hash_field: 'payload_hash', owner_target_field: 'owner_target', schema_ref_field: 'schema_ref',
    schema_digest_field: 'schema_digest', authority_provenance_ref_field: 'authority_provenance_ref',
    rank_provenance_ref_field: 'rank_provenance_ref', rank_provenance_ref: 'semantic-index-descriptor:test', surface_ref_field: 'surface_ref',
  },
  result_policy: { ref: 'semantic-result-policy:capability-discovery-default', max_result_count: 2, max_schema_bytes_per_result: 64, total_prompt_budget_bytes: 96 },
  authority_ref: 'authority:test',
  correlation_ref: 'query:test',
  hydration: { definition_id: 'action:hydrate-ranked-current-item', target: 'slot::find-current-items', address_field: 'address', revision_field: 'revision', payload_hash_field: 'content_hash' },
};

// A totally different domain shape — proves the dispatcher is not media-specific.
const LEGAL_DOCS_DESCRIPTOR: PaletteSourceDescriptor = {
  id: 'clause-search',
  dispatch: {
    target: 'slot::workflow',
    definition_id: 'action:search-clauses',
    query_field: 'text',
  },
  result_mapping: { title_field: 'clause_title', group: 'Legal Docs' },
  result_policy: { ref: 'semantic-result-policy:capability-discovery-default', max_result_count: 2, max_schema_bytes_per_result: 64, total_prompt_budget_bytes: 96 },
  authority_ref: 'authority:test',
  correlation_ref: 'query:test',
  hydration: { definition_id: 'action:hydrate-ranked-current-item', target: 'slot::find-current-items', address_field: 'address', revision_field: 'revision', payload_hash_field: 'content_hash' },
};

describe('askPaletteSourceByText — deletion test (media vs. an unrelated legal-docs descriptor)', () => {
  it('dispatches the media descriptor with its own field names and normalizes the reply', async () => {
    vi.mocked(sendRequestToBitfieldTarget)
      .mockResolvedValueOnce(bytesReply({ items: [{ address: 'package::media::content::clip-1', revision: '7', payload_hash: 'mh:7', score: 0.8 }] }))
      .mockResolvedValueOnce(bytesReply({ output: { item: { address: 'package::media::content::clip-1', canonical_address: 'package::media::content::clip-1', canonical_revision: '7', payload_hash: 'mh:7', rank_score: 0.8, rank_provenance_ref: 'semantic-index-descriptor:test', descriptor_revision: '1f:descriptor', model_provenance_ref: 'model:test', revision: '7', content_hash: 'mh:7', owner_target: 'slot::workflow', schema_ref: 'schema:clip', schema_digest: 'mh:schema', authority_provenance_ref: 'authority:7', title: 'clip-1' } } }));

    const reply = await askPaletteSourceByText(MEDIA_DESCRIPTOR, 'forehand');

    expect(sendRequestToBitfieldTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'slot::workflow',
        payload: expect.objectContaining({
          operation: 'execute_definition',
          definition_id: 'action:find-similar',
          input: { index_id: 'media-content', query_text: 'forehand', limit: 2 },
        }),
      }),
      undefined,
    );
    expect(reply?.recordId).toBe('media-content');
    expect(reply?.error).toBeNull();
    const items = (reply?.reply as { items: Array<Record<string, unknown>> }).items;
    expect(items[0].id).toBe('package::media::content::clip-1');
    expect(items[0].group).toBe('Media');
    expect(items[0].render_hint).toBe('tile');
    expect(items[0]).toMatchObject({ canonical_revision: '7', payload_hash: 'mh:7', owner_target: 'slot::workflow', schema_digest: 'mh:schema', authority_provenance_ref: 'authority:7', rank_provenance_ref: 'semantic-index-descriptor:test' });
  });

  it('dispatches the legal-docs descriptor identically — same mechanism, zero code branch on domain', async () => {
    vi.mocked(sendRequestToBitfieldTarget).mockResolvedValueOnce(
      bytesReply({ items: [{ address: 'package::legal-docs::clause::x', clause_title: 'Indemnification' }] }),
    );

    const reply = await askPaletteSourceByText(LEGAL_DOCS_DESCRIPTOR, 'indemnify');

    expect(sendRequestToBitfieldTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'slot::workflow',
        payload: expect.objectContaining({
          operation: 'execute_definition',
          definition_id: 'action:search-clauses',
          input: { text: 'indemnify' },
        }),
      }),
      undefined,
    );
    expect(reply?.recordId).toBe('clause-search');
    const items = (reply?.reply as { items: Array<Record<string, unknown>> }).items;
    expect(items).toEqual([]);
  });

  it('returns null below min_query_length instead of dispatching', async () => {
    const reply = await askPaletteSourceByText(
      { ...MEDIA_DESCRIPTOR, min_query_length: 3 },
      'ab',
    );
    expect(reply).toBeNull();
    expect(sendRequestToBitfieldTarget).not.toHaveBeenCalled();
  });

  it('surfaces a dispatch error as a reply with error set, not a thrown exception', async () => {
    vi.mocked(sendRequestToBitfieldTarget).mockRejectedValueOnce(new Error('boom'));
    const reply = await askPaletteSourceByText(MEDIA_DESCRIPTOR, 'forehand');
    expect(reply?.error).toBe('boom');
    expect(reply?.reply).toBeNull();
  });
});

describe('askAllPaletteSourcesByText', () => {
  it('fans out to every descriptor in parallel and drops null (below-min-length) replies', async () => {
    vi.mocked(sendRequestToBitfieldTarget)
      .mockResolvedValueOnce(bytesReply({ items: [{ address: 'a' }] }))
      .mockResolvedValueOnce(bytesReply({ items: [{ address: 'b' }] }));

    const replies = await askAllPaletteSourcesByText(
      [MEDIA_DESCRIPTOR, LEGAL_DOCS_DESCRIPTOR, { ...MEDIA_DESCRIPTOR, id: 'too-short', min_query_length: 99 }],
      'query',
    );
    expect(replies).toHaveLength(2);
    expect(replies.map((r) => r.recordId).sort()).toEqual(['clause-search', 'media-content']);
  });

  it('is a no-op with zero descriptors — the palette does not assume any source exists', async () => {
    const replies = await askAllPaletteSourcesByText([], 'query', 10);
    expect(replies).toEqual([]);
    expect(sendRequestToBitfieldTarget).not.toHaveBeenCalled();
  });
});

describe('canonical semantic result boundary', () => {
  const canonical = (address: string, extra: Record<string, unknown> = {}) => ({
    address,
    revision: '1',
    payload_hash: `mh:${address}`,
    score: 0.8,
    descriptor_revision: '1f:descriptor',
    model_provenance_ref: 'model:test',
    ...extra,
  });

  it('rejects malformed and oversized results while retaining only policy-bounded canonical rows', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const ranked = { items: [
      canonical('package::a'),
      { canonical_address: 'package::malformed' },
      canonical('package::huge', { input_schema: { text: 'x'.repeat(128) } }),
      canonical('package::b'),
      canonical('package::c'),
    ] };
    vi.mocked(sendRequestToBitfieldTarget).mockImplementation(async (request) => {
      const definition = (request.payload as { definition_id?: string }).definition_id;
      if (definition === 'action:find-similar') return bytesReply(ranked) as never;
      const address = ((request.payload as { input: { canonical_address: string } }).input.canonical_address);
      return bytesReply({ output: { item: { address, canonical_address: address, canonical_revision: '1', payload_hash: `mh:${address}`, rank_score: 0.8, rank_provenance_ref: 'semantic-index-descriptor:test', descriptor_revision: '1f:descriptor', model_provenance_ref: 'model:test', revision: '1', content_hash: `mh:${address}`, owner_target: 'slot::workflow', schema_ref: 'schema:action', schema_digest: 'mh:schema', authority_provenance_ref: 'authority:caller', title: address, ...(address === 'package::huge' ? { input_schema: { text: 'x'.repeat(128) } } : {}) } } }) as never;
    });
    const reply = await askPaletteSourceByText(MEDIA_DESCRIPTOR, 'discover');
    const items = (reply?.reply as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((item) => item.canonical_address)).toEqual(['package::a', 'package::b']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('palette.result.rejected'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('palette.source_query.started'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('palette.source_query.completed'));
    log.mockRestore();
  });

  it('does not permit advanced model fields to cross the descriptor binding', async () => {
    vi.mocked(sendRequestToBitfieldTarget).mockResolvedValueOnce(bytesReply({ items: [] }));
    await askPaletteSourceByText(MEDIA_DESCRIPTOR, 'plain query');
    const payload = vi.mocked(sendRequestToBitfieldTarget).mock.calls[0][0].payload as { input: Record<string, unknown> };
    expect(payload.input).toEqual({ index_id: 'media-content', query_text: 'plain query', limit: 2 });
    expect(payload.input).not.toHaveProperty('filter');
    expect(payload.input).not.toHaveProperty('authority');
    expect(payload.input).not.toHaveProperty('result_policy_ref');
  });

  it('shares each addressed policy budget across deterministically ordered sources', async () => {
    let sourceCall = 0;
    vi.mocked(sendRequestToBitfieldTarget).mockImplementation(async (request) => {
      const definition = (request.payload as { definition_id?: string }).definition_id;
      if (definition === 'action:find-similar') {
        sourceCall += 1;
        return bytesReply({ items: sourceCall === 1 ? [canonical('package::a'), canonical('package::b')] : [canonical('package::z')] }) as never;
      }
      const address = ((request.payload as { input: { canonical_address: string } }).input.canonical_address);
      return bytesReply({ output: { item: { address, canonical_address: address, canonical_revision: '1', payload_hash: `mh:${address}`, rank_score: 0.8, rank_provenance_ref: 'semantic-index-descriptor:test', descriptor_revision: '1f:descriptor', model_provenance_ref: 'model:test', revision: '1', content_hash: `mh:${address}`, owner_target: 'slot::workflow', schema_ref: 'schema:action', schema_digest: 'mh:schema', authority_provenance_ref: 'authority:caller', title: address } } }) as never;
    });
    const replies = await askAllPaletteSourcesByText([
      { ...MEDIA_DESCRIPTOR, id: 'z-source' },
      { ...MEDIA_DESCRIPTOR, id: 'a-source' },
    ], 'discover');
    expect(replies.map((reply) => reply.recordId)).toEqual(['a-source', 'z-source']);
    expect(replies.flatMap((reply) => (reply.reply as { items: unknown[] }).items)).toHaveLength(2);
  });
});
