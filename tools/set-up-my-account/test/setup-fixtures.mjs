// Independent owner-response fixtures for the setup view; runtime tests verify how these observations are made.
import policy from '../read-data/setup-policy.json' with { type: 'json' };

export function provenSetup() {
  const requirements = policy.requirements.map(row => ({ id: row.id, title: row.title, applicability: 'applicable',
    reason: 'This capability applies to the observed account setup.', evidence_refs: ['message:setup-request'], scope_ids: [],
    device_ids: row.id === 'devices' ? ['desktop'] : [], notification_routes: row.id === 'notifications' ? ['live'] : [] }));
  return {
    aiConnected: true,
    devices: [{ id: 'desktop', installed: true }, { id: 'iphone', installed: false }, { id: 'extension', installed: false }],
    notificationDevices: [{ id: 'this-mac', route: 'live', can_show: 'allowed' }],
    runtime: {
      schema: 'trillion.setup-runtime/v1', checked_at: '2026-10-08T03:00:00Z', ready: true,
      components: ['defaults', 'timed_work', 'event_intake'].map(id => ({ id, state: 'ready', ready: true, evidence: {} })),
      workflow: { exists: true, run_id: 'run:setup-fixture', state: 'finished', verified: true,
        inventory: { requirements },
        verification: { verified: requirements.map(row => ({ id: row.id, state: 'verified', scope_ids: [],
          observed: 'Observed through the real owner and accepted in the independent runtime fixture.', evidence_refs: ['message:result'] })),
          loop: { input_ref: 'message:setup-request', work_ref: 'h_setup', result_ref: 'message:result', resumed_ref: 'activity:42' } },
      },
    },
  };
}

export const pendingSetup = () => ({
  aiConnected: false, devices: [], notificationDevices: [],
  runtime: { schema: 'trillion.setup-runtime/v1', ready: false,
    components: ['defaults', 'timed_work', 'event_intake'].map(id => ({ id, state: 'pending', ready: false, evidence: {} })),
    workflow: { exists: false, state: 'not_started', verified: false } },
});
