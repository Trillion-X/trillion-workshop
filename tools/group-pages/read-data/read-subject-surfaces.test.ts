import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { findSubjectSurfaces } from './read-subject-surfaces.ts';

const scope = { actor_ref: 'actor:a', session_ref: 'session:a', subject_ref: 'group:one', action_ref: 'group-page.read', decision_proof: 'decision:one', revisions: { membership_revision: 'm1', policy_revision: 'p1', resource_revision: 'r1', session_revision: 's1' } };

describe('subject placeable surfaces', () => {
  it('preserves canonical package entry and opaque input only for the admitted subject', () => {
    const rows = [
      { address: 'surface:one', payload: JSON.stringify({ kind: 'placeable-surface', id: 'surface:one', label: 'Practice', subject_ref: 'group:one', material_target: 'component:practice', package_entry: { package_name: 'practice-owner', entry_name: 'practice' }, surface_input: { subject_ref: 'group:one', future: { opaque: true } } }) },
      { address: 'surface:hidden', payload: JSON.stringify({ kind: 'placeable-surface', id: 'surface:hidden', label: 'Hidden', subject_ref: 'group:other', material_target: 'hidden' }) },
      { address: 'legacy', payload: JSON.stringify({ kind: 'destination-descriptor', ref: 'legacy', for: 'group:one', kicker: 'Legacy' }) },
    ];
    expect(findSubjectSurfaces(rows, scope)).toEqual([{ ref: 'surface:one', label: 'Practice', materialTarget: 'component:practice', packageEntry: { packageName: 'practice-owner', entryName: 'practice' }, surfaceInput: { subject_ref: 'group:one', future: { opaque: true } } }]);
  });

  it('fails closed without a complete admitted projection scope', () => {
    expect(findSubjectSurfaces([{ payload: { kind: 'placeable-surface' } }], {})).toEqual([]);
  });

  it('accepts subject refs authored inside nested public scope input', () => {
    const rows = [
      {
        address: 'surface:introductions',
        payload: JSON.stringify({
          kind: 'placeable-surface',
          id: 'surface:introductions',
          label: 'Introductions',
          material_target: 'component:group-page',
          surface_input: {
            public_scope: { subject_ref: 'group:one' },
            future: { nested: true },
          },
        }),
      },
    ];
    expect(findSubjectSurfaces(rows, scope)).toEqual([
      {
        ref: 'surface:introductions',
        label: 'Introductions',
        materialTarget: 'component:group-page',
        surfaceInput: { public_scope: { subject_ref: 'group:one' }, future: { nested: true } },
      },
    ]);
  });
});
