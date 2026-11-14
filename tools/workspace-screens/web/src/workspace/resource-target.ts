// The shared list action interpreter calls the same installed resource operation
// as an AI/native caller. Target DATA carries logical address, never infrastructure.
import { readJson } from './api';
import { nativeResourcePresentationHost, resourcePresentationHost, resourceActionReturned } from './resource-presentation-host.mjs';
import { resourceTaskOutcome } from '../../parts/ui/show/isolated-module-surface/resource-task-outcome.mjs';

export async function runAddressedResourceAction(request: unknown): Promise<unknown> {
  const payload = request as { input?: Record<string, unknown> } | null;
  const direct = request as Record<string, unknown> | null;
  const envelope = typeof direct?.address === 'string' && typeof direct?.operation === 'string'
    ? direct : payload?.input;
  if (!envelope || typeof envelope.address !== 'string' || typeof envelope.operation !== 'string')
    throw new Error('This action does not name its resource and operation.');
  if (typeof envelope.request_key !== 'string' || !envelope.request_key.trim())
    throw new Error('This action needs a stable request key so its result can be recovered safely.');
  const sent = { ...envelope };
  const host = resourcePresentationHost(nativeResourcePresentationHost({ readJson }));
  const result = await host.invoke(sent, {});
  if (result && typeof result === 'object' && Object.hasOwn(result, 'task_id') && result.state !== 'completed') {
    // A task acceptance is not successful completion. Reject the ordinary
    // continuation so saved modules cannot mark it done, while attaching only
    // the exact request/task identity and allowlisted machine status. Reusing
    // that key asks the owner to recover its existing command without replay.
    const task = resourceTaskOutcome(result, envelope.request_key);
    if (task) throw Object.assign(new Error('The resource action has not completed. Keep its request key to recover its status.'), {
      code: 'resource_task_outcome', task,
    });
    throw new Error('The resource action did not confirm completion.');
  }
  resourceActionReturned(sent);
  return result;
}
