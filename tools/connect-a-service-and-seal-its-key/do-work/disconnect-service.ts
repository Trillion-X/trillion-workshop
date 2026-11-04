// packages/service-connections/do-work/disconnect-service.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Package-owned request builder for durable service disconnection state.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Disconnect writes the SAME fact addresses connect writes — one address
//    shape, two values. The published feed's truth columns
//    (prop:connection_state:status_ref + capability booleans) flip, so every
//    consumer sees the disconnect, not just a legacy display column.
// 2. Goes through the owner write-door (record-service-connection-facts) —
//    never a parallel action with its own address arithmetic.
// 3. The owner action and the work contract arrive through `seams`
//    (ServiceConnectionSeams); no seams = `engineSeams`, the engine route.
//
// =============================================================================

import {
  requireWrittenServiceConnectionFacts,
} from './workflow-actions';
import {
  ownerRecordStateFacts,
  declaredStateEffectFacts,
} from '../read-data/owner-record-work-contract';
import {
  conversationSourceDescriptorFacts,
  type ServiceConnectionSeams,
} from './connect-service';
import { engineSeams } from './engine-seams';
import type { ServiceConversationSourceTemplate } from '../read-data/read-service-connection-options';
type RuntimeContext = unknown;

export async function disconnectService(
  input: string | {
    connectionId: string;
    stoppedEffects?: readonly { subjectId: string; propertyId: string; value: unknown }[];
    conversationSourceTemplates?: readonly ServiceConversationSourceTemplate[];
  },
  context?: RuntimeContext,
  seams: ServiceConnectionSeams = engineSeams(context),
): Promise<unknown> {
  const id = typeof input === 'string' ? input : input.connectionId;
  const stoppedEffects = typeof input === 'string' ? undefined : input.stoppedEffects;
  const conversationSourceTemplates = typeof input === 'string' ? undefined : input.conversationSourceTemplates;
  const contract = seams.workContract();

  // Writing the write-stopped facts fires the on-change trigger
  // (trigger:publish-service-connections-on-change), which re-runs
  // publish-service-connections and advances the subscribed value address —
  // the feed re-projects REACTIVELY with no caller-side publish.
  // This state transition must stay alive until the workflow owner confirms the
  // write. The entry's scope binding therefore declares a result cell instead
  // of the package default's fire-and-forget workflow write.
  const facts = [
    ...ownerRecordStateFacts(contract, id, 'write-stopped'),
    ...declaredStateEffectFacts(stoppedEffects),
    ...conversationSourceDescriptorFacts({
      templates: conversationSourceTemplates,
      connection: { id, serviceName: '', serviceVendor: '', scopes: [] },
      active: false,
    }),
  ];
  const reply = await seams.runOwnerAction(
    'write-facts',
    { facts },
    { includeOutput: true },
  );
  requireWrittenServiceConnectionFacts(reply, facts.length);
  return reply;
}
