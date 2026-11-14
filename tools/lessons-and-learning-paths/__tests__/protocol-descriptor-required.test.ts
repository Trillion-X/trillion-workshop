import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  projectProtocolValues,
  readAcceptedProgressionDecision,
  readLearningMasteryProtocolDescriptor,
  transitionIsAllowed,
} from '../read-data/read-learning-mastery.ts';
import { descriptor } from './protocol-fixture.ts';

describe('learning mastery protocol descriptor', () => {
  it('accepts open phase, field, action, and timing tokens from DATA', () => {
    const decoded = readLearningMasteryProtocolDescriptor(descriptor);
    expect(decoded?.defaults).toEqual({ duration: 17 });
    expect(decoded?.phases.map((phase) => phase.id)).toEqual(['orient', 'execute']);
    expect(transitionIsAllowed(decoded!, 'orient', 'execute')).toBe(true);
  });

  it('fails closed without a complete descriptor or action target', () => {
    expect(readLearningMasteryProtocolDescriptor(null)).toBeNull();
    expect(readLearningMasteryProtocolDescriptor({ ...descriptor, actions: { begin: { target: '', payload: {} } } })).toBeNull();
  });

  it('projects only an accepted decision receipt with confidence and provenance', () => {
    const rejected = readAcceptedProgressionDecision({ kind: 'decision', adjustments: { result: 'forged' } });
    expect(rejected).toBeNull();
    const accepted = readAcceptedProgressionDecision({
      kind: 'accepted-progression-decision-receipt',
      decision_key: 'accepted',
      confidence: 0.9,
      provenance: { evaluator: 'owner' },
      adjustments: { result: 'verified' },
      accepted_at: '2026-07-31T00:00:00.000Z',
    });
    expect(projectProtocolValues(null, accepted)).toEqual({ result: 'verified' });
  });
});
