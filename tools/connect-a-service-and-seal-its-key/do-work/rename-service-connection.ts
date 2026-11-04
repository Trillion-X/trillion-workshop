// packages/service-connections/do-work/rename-service-connection.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Package-owned request builder for renaming a single connected account
// instance's account-identity label ("work@example.com", "Personal"). This is
// the label the owner set (or was asked to set) when the instance was
// connected — renaming it never touches the sealed credential material, only
// the durable `accountLabel` fact.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Writes through the SAME owner write-door as connect/disconnect
//    (record-service-connection-facts) — never a parallel action with its
//    own address arithmetic.
// 2. Only the `accountLabel` fact changes. No credential ref, no capability
//    flag, no status is touched by a rename.
// 3. The owner action and the work contract arrive through `seams`
//    (ServiceConnectionSeams); no seams = `engineSeams`, the engine route.
//
// =============================================================================

import type { ServiceConnectionSeams } from './connect-service';
import { engineSeams } from './engine-seams';
import {
  ownerRecordFact,
} from '../read-data/owner-record-work-contract';

export async function renameServiceConnection(
  connectionId: string,
  accountLabel: string,
  seams: ServiceConnectionSeams = engineSeams(),
): Promise<unknown> {
  const contract = seams.workContract();

  // Writing the accountLabel fact fires the on-change trigger
  // (trigger:publish-service-connections-on-change), which re-runs
  // publish-service-connections and advances the subscribed value address —
  // the feed re-projects REACTIVELY with no caller-side publish.
  return seams.runOwnerAction('write-facts', {
    facts: [ownerRecordFact(contract, connectionId, 'accountLabel', accountLabel)],
  });
}
