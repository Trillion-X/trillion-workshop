import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TrainingPlanPanel } from '@/packages/training-plan/show/TrainingPlanPanel';
import { decodeTrainingPlan } from '@/packages/training-plan/read-data/training-plan';
import { selectAdaptiveNextSession } from '@/packages/training-plan/read-data/select-adaptive-next-session';

const FEED = {
  goals: [{ id: 'g1', name: 'Forehand', domain: 'tennis' }],
  phases: [{ id: 'p1', goalId: 'g1', name: 'Build', intent: 'build', sequence: 1 }],
  weeks: [{ id: 'w1', phaseId: 'p1', sequence: 1, loadIntent: 'build' }],
  sessions: [{ id: 's1', weekBlockId: 'w1', title: 'FH depth', activity: 'technical', dose: { sets: 4, balls: 60 }, intensity: { targetSpeedKmh: 100 } }],
  progressionRules: [
    { id: 'r:up', applies_to: 'g1', condition: { metricRef: 'session.success_rate', min: 0.85 }, adjustment: { doseScale: 1.1, note: 'Advance — add load.' } },
  ],
};

afterEach(() => cleanup());

describe('TrainingPlanPanel adapted-next-session render states', () => {
  it('renders the base plan with no adapted card when there is no result', () => {
    const { container } = render(<TrainingPlanPanel plan={decodeTrainingPlan(FEED)} adapted={null} />);
    expect(container.textContent).toContain('Training Plan');
    expect(container.textContent).not.toContain('Your next session, adapted');
  });

  it('renders the adapted card with the coaching note when a high result fires a rule', () => {
    const adapted = selectAdaptiveNextSession({ ...FEED, lastResult: { sessionId: 's1', signals: [{ metricRef: 'session.success_rate', value: 0.92 }] } });
    expect(adapted).not.toBeNull();
    const { container } = render(<TrainingPlanPanel plan={decodeTrainingPlan(FEED)} adapted={adapted} />);
    expect(container.textContent).toContain('Your next session, adapted');
    expect(container.textContent).toContain('adjusted from your last result');
    expect(container.textContent).toContain('Advance — add load.');
  });

  it('shows "on track — no change" when a result fires no rule', () => {
    const adapted = selectAdaptiveNextSession({ ...FEED, lastResult: { sessionId: 's1', signals: [{ metricRef: 'session.success_rate', value: 0.7 }] } });
    const { container } = render(<TrainingPlanPanel plan={decodeTrainingPlan(FEED)} adapted={adapted} />);
    expect(container.textContent).toContain('Your next session, adapted');
    expect(container.textContent).toContain('on track — no change');
  });
});
