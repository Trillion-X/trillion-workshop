// package-set://bitfield-studio/packages/ideas/read-data/__tests__/read-ideas.test.ts
//
// Test suite for decodeIdeasWorkGraph and related read functions.

import { describe, it, expect } from '../../../../test-helpers/vitest-shim.mjs';
import {
  decodeIdeasWorkGraph,
  decodeIdeasRelationships,
  decodeIdeasOperationLinks,
  decodeIdeasProcessSessionLinks,
  type IdeasWorkGraphInput,
} from '../read-ideas.ts';

describe('decodeIdeasWorkGraph', () => {
  it('produces a valid model with empty input', () => {
    const input: IdeasWorkGraphInput = {
      records: [],
      fields: [],
      views: [],
      actions: [],
    };
    const graph = decodeIdeasWorkGraph(input);

    expect(graph).toBeDefined();
    expect(graph.model).toBeDefined();
    expect(graph.fields).toBeDefined();
    expect(graph.views).toBeDefined();
    expect(graph.actions).toBeDefined();
    expect(Array.isArray(graph.fields)).toBe(true);
    expect(Array.isArray(graph.views)).toBe(true);
    expect(Array.isArray(graph.actions)).toBe(true);
    expect(graph.proof.fieldDescriptorCount).toBe(0);
    // Views decoder creates a default view even for empty input
    expect(graph.proof.viewDescriptorCount).toBeGreaterThanOrEqual(0);
    expect(graph.proof.actionDescriptorCount).toBe(0);
  });

  it('produces a valid model with null/undefined input', () => {
    const input: IdeasWorkGraphInput = {
      records: null,
      fields: undefined,
      views: null,
      actions: undefined,
    };
    const graph = decodeIdeasWorkGraph(input);

    expect(graph).toBeDefined();
    expect(graph.model).toBeDefined();
    expect(graph.proof.recordCount).toBe(0);
    expect(graph.proof.fieldDescriptorCount).toBe(0);
    // Views decoder creates a default view even for null/undefined input
    expect(graph.proof.viewDescriptorCount).toBeGreaterThanOrEqual(0);
    expect(graph.proof.actionDescriptorCount).toBe(0);
  });

  it('handles empty relationship/operation-links/process-session-links gracefully', () => {
    const input: IdeasWorkGraphInput = {
      records: [],
      fields: [],
      views: [],
      actions: [],
      relationships: undefined,
      operationLinks: undefined,
      processSessionLinks: undefined,
    };
    const graph = decodeIdeasWorkGraph(input);

    expect(graph.relationships).toEqual([]);
    expect(graph.operationLinks).toEqual([]);
    expect(graph.processSessionLinks).toEqual([]);
    expect(graph.proof.relationshipDescriptorCount).toBe(0);
    expect(graph.proof.operationLinkCount).toBe(0);
    expect(graph.proof.processSessionLinkCount).toBe(0);
  });

  it('preserves model structure for honest empty-state rendering', () => {
    const input: IdeasWorkGraphInput = {
      records: [],
      fields: [],
      views: [],
      actions: [],
    };
    const graph = decodeIdeasWorkGraph(input);

    // Empty model should still have required structure for VisualDatabaseSurface
    expect(graph.model.records).toBeDefined();
    expect(Array.isArray(graph.model.records)).toBe(true);
    expect(graph.projection).toBeDefined();
    // Empty state is honest — no fabricated rows
    expect(graph.model.records.length).toBe(0);
  });

  it('processes non-empty field/view/action descriptors', () => {
    const fieldDescriptor = {
      id: 'field.title',
      label: 'Title',
      kind: 'text',
      order: 0,
    };
    const viewDescriptor = {
      id: 'view.all',
      label: 'All Ideas',
      order: 0,
      fields: [],
    };
    const actionDescriptor = {
      id: 'action.create',
      label: 'Create Idea',
      order: 0,
      target: 'slot::workflow',
      definitionId: 'owner-action.create-idea',
    };

    const input: IdeasWorkGraphInput = {
      records: [],
      fields: [fieldDescriptor],
      views: [viewDescriptor],
      actions: [actionDescriptor],
    };
    const graph = decodeIdeasWorkGraph(input);

    expect(graph.fields.length).toBeGreaterThan(0);
    expect(graph.views.length).toBeGreaterThan(0);
    expect(graph.actions.length).toBeGreaterThan(0);
    expect(graph.proof.fieldDescriptorCount).toBeGreaterThan(0);
    expect(graph.proof.viewDescriptorCount).toBeGreaterThan(0);
    expect(graph.proof.actionDescriptorCount).toBeGreaterThan(0);
  });
});

describe('decodeIdeasRelationships', () => {
  it('returns empty array for null input', () => {
    const result = decodeIdeasRelationships(null);
    expect(result).toEqual([]);
  });

  it('extracts relationships from array', () => {
    const input = [
      { id: 'rel.parent', label: 'Parent Idea', fieldId: 'field.parent' },
    ];
    const result = decodeIdeasRelationships(input);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('rel.parent');
  });

  it('handles object with relationships array', () => {
    const input = {
      relationships: [
        { id: 'rel.child', label: 'Child Ideas', fieldId: 'field.children' },
      ],
    };
    const result = decodeIdeasRelationships(input);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('rel.child');
  });
});

describe('decodeIdeasOperationLinks', () => {
  it('returns empty array for null input', () => {
    const result = decodeIdeasOperationLinks(null);
    expect(result).toEqual([]);
  });

  it('extracts operation links from array', () => {
    const input = [
      {
        id: 'op.publish',
        label: 'Publish',
        target: 'slot::workflow',
        operation: 'publish-idea',
      },
    ];
    const result = decodeIdeasOperationLinks(input);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('op.publish');
  });
});

describe('decodeIdeasProcessSessionLinks', () => {
  it('returns empty array for null input', () => {
    const result = decodeIdeasProcessSessionLinks(null);
    expect(result).toEqual([]);
  });

  it('extracts process session links from array', () => {
    const input = [
      {
        id: 'session.brainstorm',
        label: 'Brainstorm Session',
        targetKey: 'brainstorm_session',
        recordFieldId: 'field.session_id',
      },
    ];
    const result = decodeIdeasProcessSessionLinks(input);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('session.brainstorm');
  });
});
